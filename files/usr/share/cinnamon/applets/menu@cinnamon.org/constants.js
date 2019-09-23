const FileUtils = imports.misc.fileUtils;
const GLib = imports.gi.GLib;

const MAX_FAV_ICON_SIZE = 32;
const CATEGORY_ICON_SIZE = 22;
const APPLICATION_ICON_SIZE = 22;
const CONTEXT_MENU_ICON_SIZE = 12;

const INITIAL_BUTTON_LOAD = 30;
const NUM_SYSTEM_BUTTONS = 3;
const MAX_BUTTON_WIDTH = "max-width: 20em;";

const CAN_UNINSTALL_APPS = GLib.file_test("/usr/bin/cinnamon-remove-application", GLib.FileTest.EXISTS);
const HAVE_OPTIRUN = GLib.file_test("/usr/bin/optirun", GLib.FileTest.EXISTS);

const USER_DESKTOP_PATH = FileUtils.getUserDesktopDir();

const PRIVACY_SCHEMA = "org.cinnamon.desktop.privacy";
const REMEMBER_RECENT_KEY = "remember-recent-files";