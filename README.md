# Sofidev Maximize To Workspace

GNOME Shell extension that isolates maximized / full-screened windows into
their own workspace, **inserting the new workspace immediately to the right of
the current one** (and pushing existing workspaces further right). When you
unmaximize, unfull-screen, or close the window, it returns to the original
workspace and the inserted workspace is removed — so no empty workspaces pile
up.

Works like macOS' "fullscreen puts the app on its own space", but the new
space is inserted next to where you are instead of being appended at the end.

## Features & Behavior

- Maximize a window that shares its workspace with another window → the window
  moves to a brand-new workspace inserted **right after** the current one.
- Workspaces to the right are shifted one position to the right.
- Unmaximize / unfullscreen / close → the window returns to its original
  workspace and the inserted workspace collapses, restoring the previous order.
- A window that is alone on its workspace is not moved (nothing to isolate).
- Handles both `MAXIMIZE` and `FULLSCREEN` (including already-maximized apps
  on launch).

## Compatibility

- **GNOME Shell:** 45, 46, 47, 48, 49, 50

## Installation

### Option 1: GNOME Extensions Website (Recommended)

Install directly from [GNOME Extensions](https://extensions.gnome.org/) by searching for **Sofidev Maximize To Workspace** or using the **Extension Manager** application.

### Option 2: Manual Installation (From Source)

1. Clone or download this repository.
2. Copy the extension files to your GNOME Shell extensions directory:

   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions/sofidev-maximize-to-workspace@SofiDevO
   cp extension.js metadata.json LICENSE ~/.local/share/gnome-shell/extensions/sofidev-maximize-to-workspace@SofiDevO/
   ```

   > Note: The directory name must match the `uuid` (`sofidev-maximize-to-workspace@SofiDevO`).

3. Restart GNOME Shell:
   - **X11:** Press `Alt+F2`, type `r`, and press Enter.
   - **Wayland:** Log out and log back in.
4. Enable the extension:

   ```bash
   gnome-extensions enable sofidev-maximize-to-workspace@SofiDevO
   ```

## Packaging for GNOME Extensions Repository (EGO Upload)

If you are packaging the extension to upload to [https://extensions.gnome.org/upload/](https://extensions.gnome.org/upload/):

### Using `gnome-extensions` CLI tool (Recommended)

```bash
gnome-extensions pack --extra-source=LICENSE --force
```

This generates `sofidev-maximize-to-workspace@SofiDevO.shell-extension.zip`.

### Using `zip`

```bash
zip -r sofidev-maximize-to-workspace@SofiDevO.shell-extension.zip extension.js metadata.json LICENSE
```

After generating the `.zip` archive, submit it via [extensions.gnome.org/upload](https://extensions.gnome.org/upload/).

## Attribution

This project is a cleaned-up fork of
[**MaximizeWorkspaceHistory**](https://github.com/AmanCode22/MaximizeWorkspaceHistory)
by **AmanCode22**, originally released under the MIT License.

The original extension is no longer maintained. This fork:

- Fixes empty workspaces not being removed (they accumulated at the end).
- Changes placement from "append at the end" to "insert to the right of the
  current workspace", pushing the others to the right.
- Removes the now-unused first-empty-workspace lookup and adds re-entrancy
  guards so programmatic workspace moves don't loop.

All original code remains MIT-licensed; see [LICENSE](./LICENSE).

## Files

- `extension.js` — extension logic.
- `metadata.json` — extension metadata.
- `LICENSE` — MIT license (original author + modifications).

## License

MIT — see [LICENSE](./LICENSE).
