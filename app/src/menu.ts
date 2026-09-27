import { isTauri } from "@tauri-apps/api/core";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { isMac, runCommand, shortcutAccelerator, type CommandId } from "./commands";
import { i18n, langChoice, LANGUAGES, setLang, systemLanguage, t, type Lang, type MessageKey } from "./i18n";
import { store } from "./store";

/**
 * Native menu bar. macOS gets the usual app/File/Edit/View/Window menus; Windows gets a window
 * menu bar with File/Edit/View. Undo/Redo are app commands (EQ history), not the webview's text
 * undo. The menu is rebuilt when the language changes.
 */
export async function installMenu() {
  if (!isTauri()) return;
  let items: { undo: MenuItem; redo: MenuItem; busy: MenuItem[] } | null = null;

  const build = async () => {
    const command = (id: CommandId, key: MessageKey) =>
      MenuItem.new({ id, text: t(key), accelerator: shortcutAccelerator(id), action: () => runCommand(id, "menu") });
    const predefined = (item: "Cut" | "Copy" | "Paste" | "SelectAll", key: MessageKey) =>
      PredefinedMenuItem.new({ item, text: t(key) });
    const separator = () => PredefinedMenuItem.new({ item: "Separator" });

    const read = await command("read", "action.read");
    const apply = await command("apply", "action.apply");
    const save = await command("save", "action.save");
    const importItem = await command("import", "action.import");
    const exportItem = await command("export", "action.export");
    const undo = await command("undo", "action.undo");
    const redo = await command("redo", "action.redo");
    const settings = await command("settings", "action.settings");

    const followSystem = await CheckMenuItem.new({
      id: "lang-system",
      text: t("language.system", { lang: LANGUAGES[systemLanguage().lang] }),
      checked: langChoice() === "system",
      action: () => setLang("system"),
    });
    const languages = [
      followSystem,
      await separator(),
      ...(await Promise.all(
        (Object.keys(LANGUAGES) as Lang[]).map((code) =>
          CheckMenuItem.new({ id: `lang-${code}`, text: LANGUAGES[code], checked: code === langChoice(), action: () => setLang(code) }),
        ),
      )),
    ];

    const file = await Submenu.new({
      text: t("menu.file"),
      items: [
        read,
        apply,
        save,
        await separator(),
        importItem,
        exportItem,
        ...(isMac ? [] : [await separator(), settings, await separator(), await PredefinedMenuItem.new({ item: "Quit", text: t("menu.exit") })]),
      ],
    });
    const edit = await Submenu.new({
      text: t("menu.edit"),
      items: [
        undo,
        redo,
        await separator(),
        await predefined("Cut", "menu.cut"),
        await predefined("Copy", "menu.copy"),
        await predefined("Paste", "menu.paste"),
        await predefined("SelectAll", "menu.selectAll"),
      ],
    });
    const view = await Submenu.new({
      text: t("menu.view"),
      items: [await Submenu.new({ text: t("menu.language"), items: languages })],
    });

    const submenus = [file, edit, view];
    if (isMac) {
      const app = await Submenu.new({
        text: "Moondrop Ctrl",
        items: [
          await PredefinedMenuItem.new({ item: { About: null }, text: t("menu.about") }),
          await separator(),
          settings,
          await separator(),
          await PredefinedMenuItem.new({ item: "Services", text: t("menu.services") }),
          await separator(),
          await PredefinedMenuItem.new({ item: "Hide", text: t("menu.hide") }),
          await PredefinedMenuItem.new({ item: "HideOthers", text: t("menu.hideOthers") }),
          await PredefinedMenuItem.new({ item: "ShowAll", text: t("menu.showAll") }),
          await separator(),
          await PredefinedMenuItem.new({ item: "Quit", text: t("menu.quit") }),
        ],
      });
      const window = await Submenu.new({
        text: t("menu.window"),
        items: [
          await PredefinedMenuItem.new({ item: "Minimize", text: t("menu.minimize") }),
          await PredefinedMenuItem.new({ item: "Maximize", text: t("menu.zoom") }),
          await separator(),
          await PredefinedMenuItem.new({ item: "Fullscreen", text: t("menu.fullscreen") }),
          await PredefinedMenuItem.new({ item: "CloseWindow", text: t("menu.close") }),
        ],
      });
      submenus.unshift(app);
      submenus.push(window);
    }

    const menu = await Menu.new({ items: submenus });
    // App-wide on macOS; on Windows this becomes the menu bar of every window.
    await menu.setAsAppMenu();
    items = { undo, redo, busy: [read, apply, save, importItem, exportItem] };
    await sync();
  };

  let synced = "";
  const sync = async () => {
    if (!items) return;
    const state = `${store.canUndo}${store.canRedo}${store.busy === null}`;
    if (state === synced) return;
    synced = state;
    await items.undo.setEnabled(store.canUndo);
    await items.redo.setEnabled(store.canRedo);
    for (const item of items.busy) await item.setEnabled(store.busy === null);
  };

  await build();
  i18n.addEventListener("change", () => {
    synced = "";
    void build();
  });
  store.addEventListener("change", () => void sync());
}
