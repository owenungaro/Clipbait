# Third party

## Fonts

Bundled in `src/renderer/src/assets/fonts/`, both under the
[SIL Open Font License 1.1](https://openfontlicense.org/).

- **Archivo** by Omnibus-Type
- **IBM Plex Mono** by IBM

## FFmpeg

Not bundled. Clipbait downloads a build on first launch from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), falling back to
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/). Those are GPL builds and stay
separate from this app, which only runs them as a normal command line program.

If you already have FFmpeg on your PATH, Clipbait uses that one instead.

## Upload services

Clips are uploaded to [Catbox](https://catbox.moe) or
[Litterbox](https://litterbox.catbox.moe) only when you ask. Neither needs an
account, and neither is affiliated with this project.
