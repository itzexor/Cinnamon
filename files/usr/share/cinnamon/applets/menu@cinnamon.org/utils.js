const Mainloop = imports.mainloop;

const Cinnamon = imports.gi.Cinnamon;
const CMenu = imports.gi.CMenu;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const FileUtils = imports.misc.fileUtils;
const Util = imports.misc.util;

const { MAX_FAV_ICON_SIZE,
        NUM_SYSTEM_BUTTONS,
        USER_DESKTOP_PATH } = require('./constants');

const AppSys = Cinnamon.AppSystem.get_default();

// the magic formula that determines the size of favorite and system buttons
function getFavIconSize() {
    let monitorHeight = Main.layoutManager.primaryMonitor.height;
    let real_size = (0.7 * monitorHeight) / (global.settings.get_strv('favorite-apps').length + NUM_SYSTEM_BUTTONS);
    let icon_size = 0.6 * real_size / global.ui_scale;
    return Math.min(icon_size, MAX_FAV_ICON_SIZE);
}

/**
 * adds a panel launcher for a .desktop file id
 */
function addLauncherToPanel(id) {
    if (!Main.AppletManager.get_role_provider_exists(Main.AppletManager.Roles.PANEL_LAUNCHER)) {
        let new_applet_id = global.settings.get_int("next-applet-id");
        global.settings.set_int("next-applet-id", (new_applet_id + 1));
        let enabled_applets = global.settings.get_strv("enabled-applets");
        enabled_applets.push("panel1:right:0:panel-launchers@cinnamon.org:" + new_applet_id);
        global.settings.set_strv("enabled-applets", enabled_applets);
    }
    // wait until the panel launchers instance is actually loaded
    // 10 tries, delay 100ms
    let retries = 10;
    Mainloop.timeout_add(100, () => {
        if (retries--) {
            let launcherApplet = Main.AppletManager.get_role_provider(Main.AppletManager.Roles.PANEL_LAUNCHER);
            if (!launcherApplet)
                return true;
            launcherApplet.acceptNewLauncher(id);
        }
        return false;
    });
}

/**
 * Copies a .desktop file to the user's desktop folder
 * @param {*} id app id
 * @param {*} path path to .desktop file
 */
function copyLauncherToDesktop(id, path) {
    try {
        let src = Gio.file_new_for_path(path);
        let dest = Gio.file_new_for_path(`${USER_DESKTOP_PATH}/${id}`);
        src.copy(dest, 0, null, function(){});
        FileUtils.changeModeGFile(dest, 755);
    } catch(e) {
        global.log(e);
    }
}

/**
 * Launch a file via its default handler.
 * @param {String} input
 */
function launchFile(input) {
    if (!input)
        return false;

    let path = null;
    if (input.startsWith('/')) {
        path = input;
    } else {
        if (input.startsWith('~'))
            input = input.slice(1);
        path = GLib.get_home_dir() + '/' + input;
    }

    let file = Gio.file_new_for_path(path);
    try {
        Gio.app_info_launch_default_for_uri(file.get_uri(),
                                            global.create_app_launch_context());
    } catch (e) {
        let source = new MessageTray.SystemNotificationSource();
        Main.messageTray.add(source);
        let notification = new MessageTray.Notification(source,
                                                        _("This file is no longer available"),
                                                        e.message);
        notification.setTransient(true);
        notification.setUrgency(MessageTray.Urgency.NORMAL);
        source.notify(notification);
        return false;
    }

    return true;
}

/*
 * CMenu app loading functions
 */

// sort apps by their latinised name
function appCompare(a, b) {
    a = Util.latinise(a[0].get_name().toLowerCase());
    b = Util.latinise(b[0].get_name().toLowerCase());
    return a > b;
}

/**
 * sort cmenu directories with admin and prefs categories last
 */
function dirCompare(a, b) {
    let menuIdA = a.get_menu_id().toLowerCase();
    let menuIdB = b.get_menu_id().toLowerCase();

    let prefCats = ["administration", "preferences"];
    let prefIdA = prefCats.indexOf(menuIdA);
    let prefIdB = prefCats.indexOf(menuIdB);

    if (prefIdA < 0 && prefIdB >= 0) {
        return -1;
    }
    if (prefIdA >= 0 && prefIdB < 0) {
        return 1;
    }

    let nameA = a.get_name().toLowerCase();
    let nameB = b.get_name().toLowerCase();

    if (nameA > nameB) {
        return 1;
    }
    if (nameA < nameB) {
        return -1;
    }
    return 0;
}

/**
 * returns all apps and the categories they belong to, and all top level categories
 *
 * [
 *   [
 *     app 1,
 *     [
 *       top level category 1,
 *       random category,
 *       random category
 *     ]
 *   ],
 *   ...
 * ],
 * [
 *   top level category 1,
 *   top level category 2,
 *   top level category 3,
 *   top level category 4,
 *   ...
 * ] */
function getApps() {
    let apps = new Map();
    let dirs = [];

    let tree = AppSys.get_tree();
    let root = tree.get_root_directory();
    let iter = root.iter();
    let nextType;

    while ((nextType = iter.next()) != CMenu.TreeItemType.INVALID) {
        if (nextType == CMenu.TreeItemType.DIRECTORY) {
            let dir = iter.get_directory();
            if (loadDirectory(dir, dir, apps))
                dirs.push(dir);
        }
    }

    dirs.sort(dirCompare);
    let sortedApps = Array.from(apps.entries()).sort(appCompare);

    return [sortedApps, dirs];
}

 /**
  * load, from a cmenu directory, all apps and their categories
  * into a given Map()
  * @param {*} dir a CMenuDirectory to traverse
  * @param {*} top_dir same as %dir except during recursion
  * @param {*} apps a Map() to load entries into
  */
function loadDirectory(dir, top_dir, apps) {
    let iter = dir.iter();
    let has_entries = false;
    let nextType;
    while ((nextType = iter.next()) != CMenu.TreeItemType.INVALID) {
        if (nextType == CMenu.TreeItemType.ENTRY) {
            let desktopId = iter.get_entry().get_desktop_file_id();
            let app = AppSys.lookup_app(desktopId);
            if (!app || app.get_nodisplay())
                continue;

            has_entries = true;
            if (apps.has(app))
                apps.get(app).push(dir.get_menu_id());
            else
                apps.set(app, [top_dir.get_menu_id()]);
        } else if (nextType == CMenu.TreeItemType.DIRECTORY) {
            has_entries = loadDirectory(iter.get_directory(), top_dir, apps);
        }
    }
    return has_entries;
}


/* VisibleChildIterator takes a container (boxlayout, etc.)
 * and creates an array of its visible children and their index
 * positions.  We can then work through that list without
 * mucking about with positions and math, just give a
 * child, and it'll give you the next or previous, or first or
 * last child in the list.
 *
 * We could have this object regenerate off a signal
 * every time the visibles have changed in our applicationBox,
 * but we really only need it when we start keyboard
 * navigating, so increase speed, we reload only when we
 * want to use it.
 */

