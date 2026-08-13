// clipbait-capture.exe
//
// Captures one monitor with Windows.Graphics.Capture and hardware-encodes it
// to H.264 with Media Foundation, writing a raw Annex-B elementary stream to
// stdout. Everything from the captured texture to the compressed bitstream
// stays on the GPU: WGC hands back a D3D11 texture, a Video Processor MFT
// converts BGRA -> NV12 in VRAM, and a hardware H.264 encoder MFT (whichever
// the GPU vendor exposes: NVENC, Quick Sync, AMF...) encodes that texture
// directly. There is no per-frame GPU-to-system-memory round trip.
//
// This exists because FFmpeg's Desktop Duplication path (ddagrab) downloads
// every frame to system RAM before re-uploading it to the encoder, and on
// this app's target hardware that per-frame readback plus DDA's interaction
// with fullscreen games was enough to collapse an armed capture to ~1 fps.
// WGC additionally coexists with fullscreen/MPO far better than DDA.
//
// Raw WinRT ABI headers + WRL::ComPtr are used instead of the C++/WinRT
// projection so the build needs nothing beyond the Windows SDK that ships
// with MSVC — no cppwinrt.exe header generation, no NuGet restore.
//
// Usage:
//   clipbait-capture.exe --monitor <index> --fps <n> --bitrate <kbps> [--cursor 0|1] [--probe]
//
// Monitor index follows the same left-to-right, top-to-bottom ordering the
// rest of the app already uses for ddagrab's output_idx (see displays.ts).
//
// Protocol: a single "READY" line on stderr once capture has actually
// started (or, under --probe, once the whole pipeline stood up without
// starting capture) tells the caller this machine can do GPU capture at
// all; anything else on stderr is a human-readable error. Compressed H.264
// goes to stdout, and nothing else ever does.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <wrl/client.h>
#include <wrl/wrappers/corewrappers.h>
#include <roapi.h>
#include <inspectable.h>

#include <d3d11.h>
#include <dxgi1_2.h>

#include <windows.graphics.h>
#include <windows.graphics.directx.h>
#include <windows.graphics.directx.direct3d11.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.capture.interop.h>

#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mftransform.h>
#include <mferror.h>
#include <codecapi.h>

#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <chrono>
#include <thread>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Wrappers::HStringReference;

namespace WGC = ABI::Windows::Graphics::Capture;
namespace WGDX = ABI::Windows::Graphics::DirectX;
namespace WGDXD3D = ABI::Windows::Graphics::DirectX::Direct3D11;

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "runtimeobject.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "windowsapp.lib")
#pragma comment(lib, "user32.lib")

namespace {

/* ------------------------------------------------------------------ util */

void Fail(const char* what, HRESULT hr) {
  fprintf(stderr, "ERROR: %s (hr=0x%08lx)\n", what, static_cast<unsigned long>(hr));
  fflush(stderr);
  ExitProcess(1);
}

void FailMsg(const char* what) {
  fprintf(stderr, "ERROR: %s\n", what);
  fflush(stderr);
  ExitProcess(1);
}

#define CHECK_HR(expr, what)                     \
  do {                                            \
    HRESULT _hr = (expr);                         \
    if (FAILED(_hr)) Fail((what), _hr);            \
  } while (0)

/* -------------------------------------------------------------- options */

struct Options {
  int monitorIndex = 0;
  int fps = 60;
  int bitrateKbps = 30000;
  bool cursor = true;
  bool probe = false;
};

Options ParseArgs(int argc, char** argv) {
  Options o;
  for (int i = 1; i < argc; i++) {
    std::string arg = argv[i];
    auto next = [&](int& out) {
      if (i + 1 < argc) out = std::atoi(argv[++i]);
    };
    if (arg == "--monitor") next(o.monitorIndex);
    else if (arg == "--fps") next(o.fps);
    else if (arg == "--bitrate") next(o.bitrateKbps);
    else if (arg == "--cursor") {
      int v = 1;
      next(v);
      o.cursor = v != 0;
    } else if (arg == "--probe") {
      o.probe = true;
    }
  }
  if (o.fps <= 0) o.fps = 60;
  if (o.bitrateKbps <= 0) o.bitrateKbps = 30000;
  return o;
}

/* ---------------------------------------------------------- monitor pick */

struct MonitorEntry {
  HMONITOR handle;
  LONG left;
  LONG top;
};

BOOL CALLBACK CollectMonitor(HMONITOR hMon, HDC, LPRECT rect, LPARAM lParam) {
  auto* list = reinterpret_cast<std::vector<MonitorEntry>*>(lParam);
  list->push_back({hMon, rect->left, rect->top});
  return TRUE;
}

// Left-to-right, top-to-bottom — the same ordering displays.ts uses to
// assign ddagrab's output_idx, so an index means the same monitor either way.
HMONITOR PickMonitor(int index) {
  std::vector<MonitorEntry> monitors;
  EnumDisplayMonitors(nullptr, nullptr, CollectMonitor, reinterpret_cast<LPARAM>(&monitors));
  if (monitors.empty()) FailMsg("no monitors found");
  std::sort(monitors.begin(), monitors.end(), [](const MonitorEntry& a, const MonitorEntry& b) {
    if (a.left != b.left) return a.left < b.left;
    return a.top < b.top;
  });
  if (index < 0 || index >= static_cast<int>(monitors.size())) index = 0;
  return monitors[static_cast<size_t>(index)].handle;
}

/* --------------------------------------------------------------- d3d11 */

struct D3DContext {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<WGDXD3D::IDirect3DDevice> winrtDevice;
  ComPtr<IMFDXGIDeviceManager> mfDeviceManager;
  UINT mfResetToken = 0;
};

D3DContext CreateD3D() {
  D3DContext ctx;
  D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  D3D_FEATURE_LEVEL chosen;
  CHECK_HR(
      D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                         D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                         levels, ARRAYSIZE(levels), D3D11_SDK_VERSION, &ctx.device, &chosen,
                         &ctx.context),
      "D3D11CreateDevice");

  ComPtr<IDXGIDevice> dxgiDevice;
  CHECK_HR(ctx.device.As(&dxgiDevice), "QI IDXGIDevice");

  ComPtr<IInspectable> inspectable;
  CHECK_HR(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), &inspectable),
           "CreateDirect3D11DeviceFromDXGIDevice");
  CHECK_HR(inspectable.As(&ctx.winrtDevice), "QI IDirect3DDevice");

  CHECK_HR(MFCreateDXGIDeviceManager(&ctx.mfResetToken, &ctx.mfDeviceManager),
           "MFCreateDXGIDeviceManager");
  CHECK_HR(ctx.mfDeviceManager->ResetDevice(ctx.device.Get(), ctx.mfResetToken),
           "IMFDXGIDeviceManager::ResetDevice");
  return ctx;
}

/* ------------------------------------------------------------------ wgc */

struct CaptureSession {
  ComPtr<WGC::IGraphicsCaptureItem> item;
  ComPtr<WGC::IDirect3D11CaptureFramePool> framePool;
  ComPtr<WGC::IGraphicsCaptureSession> session;
  int width = 0;
  int height = 0;
};

CaptureSession StartCapture(const D3DContext& d3d, HMONITOR monitor, bool cursor) {
  CaptureSession cap;

  ComPtr<WGC::IGraphicsCaptureItemInterop> interop;
  CHECK_HR(RoGetActivationFactory(HStringReference(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem).Get(),
                                   IID_PPV_ARGS(&interop)),
           "activate GraphicsCaptureItem factory");
  CHECK_HR(interop->CreateForMonitor(monitor, IID_PPV_ARGS(&cap.item)), "CreateForMonitor");

  ABI::Windows::Graphics::SizeInt32 size;
  CHECK_HR(cap.item->get_Size(&size), "IGraphicsCaptureItem::get_Size");
  cap.width = size.Width;
  cap.height = size.Height;

  ComPtr<WGC::IDirect3D11CaptureFramePoolStatics2> poolStatics;
  CHECK_HR(RoGetActivationFactory(
               HStringReference(RuntimeClass_Windows_Graphics_Capture_Direct3D11CaptureFramePool).Get(),
               IID_PPV_ARGS(&poolStatics)),
           "activate Direct3D11CaptureFramePool factory");
  CHECK_HR(poolStatics->CreateFreeThreaded(d3d.winrtDevice.Get(),
                                            WGDX::DirectXPixelFormat_B8G8R8A8UIntNormalized, 2, size,
                                            &cap.framePool),
           "CreateFreeThreaded");

  CHECK_HR(cap.framePool->CreateCaptureSession(cap.item.Get(), &cap.session), "CreateCaptureSession");

  ComPtr<WGC::IGraphicsCaptureSession2> session2;
  if (SUCCEEDED(cap.session.As(&session2))) session2->put_IsCursorCaptureEnabled(cursor);

  CHECK_HR(cap.session->StartCapture(), "StartCapture");
  return cap;
}

// Drains the pool down to the single newest frame; WGC frames must be
// explicitly Close()d when discarded or the pool's buffer slots leak.
ComPtr<WGC::IDirect3D11CaptureFrame> TakeLatestFrame(CaptureSession& cap) {
  ComPtr<WGC::IDirect3D11CaptureFrame> latest;
  for (;;) {
    ComPtr<WGC::IDirect3D11CaptureFrame> frame;
    cap.framePool->TryGetNextFrame(&frame);
    if (!frame) break;
    if (latest) {
      ComPtr<ABI::Windows::Foundation::IClosable> closable;
      if (SUCCEEDED(latest.As(&closable))) closable->Close();
    }
    latest = frame;
  }
  return latest;
}

ComPtr<ID3D11Texture2D> TextureFromFrame(WGC::IDirect3D11CaptureFrame* frame) {
  ComPtr<WGDXD3D::IDirect3DSurface> surface;
  CHECK_HR(frame->get_Surface(&surface), "IDirect3D11CaptureFrame::get_Surface");
  ComPtr<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;
  CHECK_HR(surface.As(&access), "QI IDirect3DDxgiInterfaceAccess");
  ComPtr<ID3D11Texture2D> texture;
  CHECK_HR(access->GetInterface(IID_PPV_ARGS(&texture)), "IDirect3DDxgiInterfaceAccess::GetInterface");
  return texture;
}

/* ------------------------------------------------------- media foundation */

ComPtr<IMFSample> WrapTexture(ID3D11Texture2D* texture, LONGLONG time, LONGLONG duration) {
  ComPtr<IMFMediaBuffer> buffer;
  CHECK_HR(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), texture, 0, FALSE, &buffer),
           "MFCreateDXGISurfaceBuffer");
  ComPtr<IMFSample> sample;
  CHECK_HR(MFCreateSample(&sample), "MFCreateSample");
  CHECK_HR(sample->AddBuffer(buffer.Get()), "IMFSample::AddBuffer");
  sample->SetSampleTime(time);
  sample->SetSampleDuration(duration);
  return sample;
}

ComPtr<IMFTransform> CreateColorConverter(const D3DContext& d3d, int width, int height) {
  ComPtr<IMFTransform> mft;
  CHECK_HR(CoCreateInstance(CLSID_VideoProcessorMFT, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&mft)),
           "CoCreateInstance CLSID_VideoProcessorMFT");
  CHECK_HR(mft->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER,
                                reinterpret_cast<ULONG_PTR>(d3d.mfDeviceManager.Get())),
           "color converter SET_D3D_MANAGER");

  ComPtr<IMFMediaType> inType;
  CHECK_HR(MFCreateMediaType(&inType), "MFCreateMediaType (vp in)");
  inType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  inType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_ARGB32);
  MFSetAttributeSize(inType.Get(), MF_MT_FRAME_SIZE, static_cast<UINT32>(width), static_cast<UINT32>(height));
  inType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  CHECK_HR(mft->SetInputType(0, inType.Get(), 0), "vp SetInputType");

  ComPtr<IMFMediaType> outType;
  CHECK_HR(MFCreateMediaType(&outType), "MFCreateMediaType (vp out)");
  outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  outType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  MFSetAttributeSize(outType.Get(), MF_MT_FRAME_SIZE, static_cast<UINT32>(width), static_cast<UINT32>(height));
  outType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  CHECK_HR(mft->SetOutputType(0, outType.Get(), 0), "vp SetOutputType");

  return mft;
}

struct Encoder {
  ComPtr<IMFTransform> mft;
  ComPtr<IMFMediaEventGenerator> events;
  bool outputProvidesSamples = false;
  DWORD outputBufferSize = 0;
};

Encoder CreateEncoder(const D3DContext& d3d, int width, int height, int fps, int bitrateKbps) {
  Encoder enc;

  MFT_REGISTER_TYPE_INFO outInfo = {MFMediaType_Video, MFVideoFormat_H264};
  IMFActivate** activates = nullptr;
  UINT32 count = 0;
  CHECK_HR(MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                      nullptr, &outInfo, &activates, &count),
           "MFTEnumEx video encoders");
  if (count == 0) FailMsg("no hardware H.264 encoder available on this system");

  HRESULT activateHr = activates[0]->ActivateObject(IID_PPV_ARGS(&enc.mft));
  for (UINT32 i = 0; i < count; i++) activates[i]->Release();
  CoTaskMemFree(activates);
  if (FAILED(activateHr)) Fail("ActivateObject on hardware H.264 encoder", activateHr);

  CHECK_HR(enc.mft->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER,
                                    reinterpret_cast<ULONG_PTR>(d3d.mfDeviceManager.Get())),
           "encoder SET_D3D_MANAGER");

  ComPtr<IMFAttributes> attrs;
  if (SUCCEEDED(enc.mft->GetAttributes(&attrs))) {
    UINT32 isAsync = 0;
    attrs->GetUINT32(MF_TRANSFORM_ASYNC, &isAsync);
    if (isAsync) attrs->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE);
  }
  CHECK_HR(enc.mft.As(&enc.events), "QI IMFMediaEventGenerator");

  ComPtr<IMFMediaType> outType;
  CHECK_HR(MFCreateMediaType(&outType), "MFCreateMediaType (enc out)");
  outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  outType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
  outType->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(bitrateKbps) * 1000u);
  MFSetAttributeSize(outType.Get(), MF_MT_FRAME_SIZE, static_cast<UINT32>(width), static_cast<UINT32>(height));
  MFSetAttributeRatio(outType.Get(), MF_MT_FRAME_RATE, static_cast<UINT32>(fps), 1);
  outType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  outType->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main);
  CHECK_HR(enc.mft->SetOutputType(0, outType.Get(), 0), "encoder SetOutputType");

  ComPtr<IMFMediaType> inType;
  CHECK_HR(MFCreateMediaType(&inType), "MFCreateMediaType (enc in)");
  inType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  inType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  MFSetAttributeSize(inType.Get(), MF_MT_FRAME_SIZE, static_cast<UINT32>(width), static_cast<UINT32>(height));
  MFSetAttributeRatio(inType.Get(), MF_MT_FRAME_RATE, static_cast<UINT32>(fps), 1);
  inType->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  CHECK_HR(enc.mft->SetInputType(0, inType.Get(), 0), "encoder SetInputType");

  // Best-effort tuning: keep a keyframe roughly every two seconds so the
  // segment muxer downstream can cut clips on tight boundaries, and prefer
  // CBR to match the bitrate we just declared. Not every hardware MFT honours
  // these, so failures here are not fatal.
  ComPtr<ICodecAPI> codecApi;
  if (SUCCEEDED(enc.mft.As(&codecApi))) {
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_UI4;
    v.ulVal = static_cast<ULONG>(fps) * 2;
    codecApi->SetValue(&CODECAPI_AVEncMPVGOPSize, &v);
    v.ulVal = eAVEncCommonRateControlMode_CBR;
    codecApi->SetValue(&CODECAPI_AVEncCommonRateControlMode, &v);
    VariantClear(&v);
  }

  MFT_OUTPUT_STREAM_INFO streamInfo = {};
  CHECK_HR(enc.mft->GetOutputStreamInfo(0, &streamInfo), "encoder GetOutputStreamInfo");
  enc.outputProvidesSamples =
      (streamInfo.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
  enc.outputBufferSize = streamInfo.cbSize;

  enc.mft->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
  enc.mft->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
  return enc;
}

void WriteSampleToStdout(IMFSample* sample) {
  ComPtr<IMFMediaBuffer> buffer;
  if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) return;
  BYTE* data = nullptr;
  DWORD len = 0;
  if (FAILED(buffer->Lock(&data, nullptr, &len))) return;
  if (len > 0) {
    fwrite(data, 1, len, stdout);
    fflush(stdout);
  }
  buffer->Unlock();
}

// Pulls whatever the encoder has ready and writes it to stdout. Called in
// response to a METransformHaveOutput event.
void PullEncoderOutput(Encoder& enc) {
  MFT_OUTPUT_DATA_BUFFER outBuf = {};
  outBuf.dwStreamID = 0;

  ComPtr<IMFSample> ownSample;
  if (!enc.outputProvidesSamples) {
    ComPtr<IMFMediaBuffer> buffer;
    if (FAILED(MFCreateMemoryBuffer(enc.outputBufferSize, &buffer))) return;
    if (FAILED(MFCreateSample(&ownSample))) return;
    ownSample->AddBuffer(buffer.Get());
    outBuf.pSample = ownSample.Get();
  }

  DWORD status = 0;
  HRESULT hr = enc.mft->ProcessOutput(0, 1, &outBuf, &status);
  if (outBuf.pEvents) outBuf.pEvents->Release();

  if (hr == MF_E_TRANSFORM_STREAM_CHANGE || hr == MF_E_TRANSFORM_NEED_MORE_INPUT) return;
  if (FAILED(hr)) return;

  IMFSample* resultSample = outBuf.pSample ? outBuf.pSample : ownSample.Get();
  if (resultSample) WriteSampleToStdout(resultSample);
  if (outBuf.pSample && outBuf.pSample != ownSample.Get()) outBuf.pSample->Release();
}

}  // namespace

/* ------------------------------------------------------------------- main */

int main(int argc, char** argv) {
  Options opts = ParseArgs(argc, argv);

  _setmode(_fileno(stdout), _O_BINARY);

  CHECK_HR(RoInitialize(RO_INIT_MULTITHREADED), "RoInitialize");
  CHECK_HR(MFStartup(MF_VERSION), "MFStartup");

  D3DContext d3d = CreateD3D();
  HMONITOR monitor = PickMonitor(opts.monitorIndex);
  CaptureSession cap = StartCapture(d3d, monitor, opts.cursor);

  ComPtr<IMFTransform> colorConverter = CreateColorConverter(d3d, cap.width, cap.height);
  Encoder encoder = CreateEncoder(d3d, cap.width, cap.height, opts.fps, opts.bitrateKbps);

  if (opts.probe) {
    // Prove the whole pipeline stands up without actually running capture.
    cap.session->Close();
    fprintf(stderr, "READY\n");
    fflush(stderr);
    return 0;
  }

  fprintf(stderr, "READY\n");
  fflush(stderr);

  const LONGLONG frameDuration = 10'000'000LL / opts.fps;  // 100ns units
  auto tickInterval = std::chrono::microseconds(1'000'000LL / opts.fps);
  auto nextTick = std::chrono::steady_clock::now();

  ComPtr<ID3D11Texture2D> lastTexture;
  LONGLONG frameIndex = 0;
  bool encoderWantsInput = true;

  for (;;) {
    // Drain any encoder events that arrived since the last spin without
    // blocking — a hardware encoder MFT is an async object and only accepts
    // ProcessInput after it signals METransformNeedInput.
    for (;;) {
      ComPtr<IMFMediaEvent> event;
      HRESULT hr = encoder.events->GetEvent(MF_EVENT_FLAG_NO_WAIT, &event);
      if (FAILED(hr) || !event) break;
      MediaEventType type = MEUnknown;
      event->GetType(&type);
      if (type == METransformNeedInput) encoderWantsInput = true;
      else if (type == METransformHaveOutput) PullEncoderOutput(encoder);
    }

    std::this_thread::sleep_until(nextTick);
    nextTick += tickInterval;

    ComPtr<WGC::IDirect3D11CaptureFrame> frame = TakeLatestFrame(cap);
    ComPtr<ID3D11Texture2D> texture;
    if (frame) {
      texture = TextureFromFrame(frame.Get());
      lastTexture = texture;
    } else if (lastTexture) {
      // Nothing new since the last tick (idle desktop) — resubmit the last
      // frame so the encoder keeps a steady cadence, same as ddagrab's
      // default dup_frames behaviour.
      texture = lastTexture;
    } else {
      continue;
    }

    LONGLONG time = frameIndex * frameDuration;
    frameIndex++;

    ComPtr<IMFSample> vpIn = WrapTexture(texture.Get(), time, frameDuration);
    colorConverter->ProcessInput(0, vpIn.Get(), 0);

    ComPtr<ID3D11Texture2D> nv12;
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = static_cast<UINT>(cap.width);
    desc.Height = static_cast<UINT>(cap.height);
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_NV12;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    if (FAILED(d3d.device->CreateTexture2D(&desc, nullptr, &nv12))) continue;

    ComPtr<IMFSample> vpOut = WrapTexture(nv12.Get(), time, frameDuration);
    MFT_OUTPUT_DATA_BUFFER vpOutBuf = {};
    vpOutBuf.dwStreamID = 0;
    vpOutBuf.pSample = vpOut.Get();
    DWORD vpStatus = 0;
    if (FAILED(colorConverter->ProcessOutput(0, 1, &vpOutBuf, &vpStatus))) continue;

    if (encoderWantsInput) {
      if (SUCCEEDED(encoder.mft->ProcessInput(0, vpOut.Get(), 0))) encoderWantsInput = false;
    }

    if (frame) {
      ComPtr<ABI::Windows::Foundation::IClosable> closable;
      if (SUCCEEDED(frame.As(&closable))) closable->Close();
    }
  }
}
