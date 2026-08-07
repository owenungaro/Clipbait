# Clipbait

Instant replay for your screen. It keeps the last x seconds running in the background, and when something good happens you press a key and it saves. Like ShadowPlay, except it works on whatever GPU you have and it can turn the clip into a shareable link right away.

Windows only.

## Download

Grab the installer from [Releases](https://github.com/owenungaro/Clipbait/releases/latest) and run it.

That's the whole setup. First launch pulls down FFmpeg by itself, so there's nothing else to install.

Windows will probably throw up a SmartScreen warning because I haven't paid for a code signing cert. Click "More info" then "Run anyway".

After that Clipbait keeps itself up to date. It checks the GitHub releases on launch, quietly downloads a newer version in the background, and installs it the next time you quit. You can also force a check under **Setup > General > Updates**, and when one is ready you'll get a "Restart to update" prompt in the tray.

## Using it

1. Hit **Arm**
2. Go play something
3. Press **F9** when something worth keeping happens

The clip lands in `Videos\Clipbait` and a small card slides into the corner of your screen. Drag the thumbnail out of that card straight into Discord, or hit **Get link** to upload it.

## Hotkeys

| Key             | Does                     |
| --------------- | ------------------------ |
| `F9`            | Save a clip              |
| `Ctrl+Shift+F9` | Arm or disarm the buffer |
| `Ctrl+Shift+C`  | Open the window          |

All rebindable under **Setup > Keys**. Function keys work on their own, anything else needs a modifier or it would swallow that key everywhere else on your system.

## Settings

Everything lives behind the **Setup** button.

**Capture.** Pick your monitor (each tile shows a live frame so you can tell which one is which), frame rate, resolution, and encoder. Auto grabs the fastest hardware encoder you've got, so NVENC on Nvidia, Quick Sync on Intel, AMF on AMD. Buffer length is how far back a clip reaches.

**Audio.** Desktop sound and mic, mixed into one track, both with level sliders.

**Output.** Where clips go and what they get named. The pattern takes `{app}`, `{date}`, `{time}`, `{datetime}` and `{display}`. `{app}` is whatever you had focused, so clips come out named like `VALORANT 2026-08-06 21-14-02.mp4`.

**Overlay.** The card that appears after a clip. Stick it on your second monitor, pick a corner, set how long it hangs around, or turn it off.

**Sharing.** Catbox is permanent and takes up to 200MB. Litterbox takes up to 1GB but expires. Flip on auto upload if you want every clip turned into a link without being asked.

## Your clips

The main screen is a wall of everything you've kept. Clips get sorted into **Games** and **Apps** on their own based on where the exe lives, so anything under steamapps, Riot Games, Epic and so on gets tagged as a game. If it guesses wrong, pick that source from the dropdown and there's a button to fix it. The correction sticks for everything from that app, past and future.

Hover a clip for Get link, Play, Folder and Delete. Drag the thumbnail anywhere to hand the actual file over.

## About the links

Anything you upload is public. No account, no password, anyone with the link can watch it. Only upload stuff you're fine with people seeing.

## Building it yourself

```bash
npm install
npm run dev     # run it in dev
npm run dist    # build the installer into release/
```

Needs Node 20 or newer.

## Cutting a release

Auto-update reads a `latest.yml` off the GitHub release, so releases have to go up through electron-builder rather than by hand-dragging the exe.

1. Bump `version` in `package.json` (the updater only fires when the release is newer than what's installed).
2. Export a GitHub token with `repo` scope: `export GH_TOKEN=…`
3. `npm run release`

That builds the installer and uploads the `.exe`, its `.blockmap` and `latest.yml` to a draft release on GitHub. Publish the draft and every existing install picks it up on next launch. (The `.blockmap` and `latest.yml` are what make updates work — if you ever upload manually, include them.)

The one build that can't auto-update is the one someone installed *before* this feature existed; they'll need to grab the next version from Releases by hand, and it's automatic from there.

## License

MIT
