const Applet = imports.ui.applet;
const Mainloop = imports.mainloop;
const Cinnamon = imports.gi.Cinnamon;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const AppFavorites = imports.ui.appFavorites;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Atk = imports.gi.Atk;
const GnomeSession = imports.misc.gnomeSession;
const ScreenSaver = imports.misc.screenSaver;
const Util = imports.misc.util;
const Meta = imports.gi.Meta;
const DocInfo = imports.misc.docInfo;
const GLib = imports.gi.GLib;
const Settings = imports.ui.settings;
const SearchProviderManager = imports.ui.searchProviderManager;
const DND = imports.ui.dnd;

const { SimpleMenuItem,
        SimpleMenuBox,
        RecentButton,
        FavoritesButton,
        SystemButton,
        PlaceButton,
        ApplicationButton,
        CategoriesBox,
        FavoritesBox,
        TransientButton,
        SearchProviderResultButton,
        CategoryButton } = require('./actors');

const { PRIVACY_SCHEMA,
        REMEMBER_RECENT_KEY,
        INITIAL_BUTTON_LOAD,
        APPLICATION_ICON_SIZE } = require('./constants');

const { getApps,
        launchFile } = require('./utils')

const appFavs = AppFavorites.getAppFavorites();

// applet refresh types
const RefreshFlags = Object.freeze({
    APP:    0b00001,
    FAV:    0b00010,
    PLACE:  0b00100,
    RECENT: 0b01000,
    SYSTEM: 0b10000
});

const REFRESH_ALL_MASK = 0b11111;

let appsys = Cinnamon.AppSystem.get_default();

class CinnamonMenuApplet extends Applet.TextIconApplet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this.set_applet_tooltip(_("Menu"));
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this.settings = new Settings.AppletSettings(this, "menu@cinnamon.org", instance_id);

        this.settings.bind("show-places", "showPlaces", () => this.queueRefresh(RefreshFlags.PLACE));
        this.settings.bind("show-recents", "showRecents", () => this.queueRefresh(RefreshFlags.RECENT));

        this._appletEnterEventId = 0;
        this._appletLeaveEventId = 0;
        this._appletHoverDelayId = 0;

        this.settings.bind("hover-delay", "hover_delay_ms", this._updateActivateOnHover);
        this.settings.bind("activate-on-hover", "activateOnHover", this._updateActivateOnHover);
        this._updateActivateOnHover();

        this.menu.setCustomStyleClass('menu-background');
        this.menu.connect('open-state-changed', (menu, state) => { this._onOpenStateChanged(state) });

        this.settings.bind("menu-custom", "menuCustom", this._updateIconAndLabel);
        this.settings.bind("menu-icon", "menuIcon", this._updateIconAndLabel);
        this.settings.bind("menu-label", "menuLabel", this._updateIconAndLabel);
        this.settings.bind("overlay-key", "overlayKey", this._updateKeybinding);
        this.settings.bind("show-category-icons", "showCategoryIcons", () => this._updateShowIcons(this.categoriesBox, this.showCategoryIcons));
        this.settings.bind("show-application-icons", "showApplicationIcons", () => this._updateShowIcons(this.applicationsBox, this.showApplicationIcons));
        this.settings.bind("favbox-show", "favBoxShow", this._favboxtoggle);
        this.settings.bind("enable-animation", "enableAnimation", null);
        this.settings.bind("favbox-min-height", "favBoxMinHeight", this._recalc_height);

        this._updateKeybinding();

        Main.themeManager.connect("theme-set", () => { this._updateIconAndLabel() });
        this._updateIconAndLabel();

        this._searchInactiveIcon = new St.Icon({ style_class: 'menu-search-entry-icon',
            icon_name: 'edit-find',
            icon_type: St.IconType.SYMBOLIC });
        this._searchActiveIcon = new St.Icon({ style_class: 'menu-search-entry-icon',
            icon_name: 'edit-clear',
            icon_type: St.IconType.SYMBOLIC });
        this._searchIconClickedId = 0;
        this._applicationsButtons = [];
        this._favoritesButtons = [];
        this._placesButtons = [];
        this._transientButtons = [];
        this.recentButton = null;
        this._recentButtons = [];
        this._categoryButtons = [];
        this._searchProviderButtons = [];
        this._selectedItemIndex = null;
        this._previousSelectedActor = null;
        this._previousVisibleIndex = null;
        this._previousTreeSelectedActor = null;
        this._activeContainer = null;
        this._activeActor = null;
        this._knownApps = new Set(); // Used to keep track of apps that are already installed, so we can highlight newly installed ones
        this._appsWereRefreshed = false;
        this.RecentManager = DocInfo.getDocManager();
        this.privacy_settings = new Gio.Settings( {schema_id: PRIVACY_SCHEMA} );
        this.noRecentDocuments = true;
        this._activeContextMenuParent = null;
        this._activeContextMenuItem = null;
        this._display();
        appsys.connect('installed-changed', () => this.queueRefresh(RefreshFlags.APP | RefreshFlags.FAV));
        AppFavorites.getAppFavorites().connect('changed', () => this.queueRefresh(RefreshFlags.FAV));
        Main.placesManager.connect('places-updated', () => this.queueRefresh(RefreshFlags.PLACE));
        this.RecentManager.connect('changed', () => this.queueRefresh(RefreshFlags.RECENT));
        this.privacy_settings.connect("changed::" + REMEMBER_RECENT_KEY, () => this.queueRefresh(RefreshFlags.RECENT));
        this._fileFolderAccessActive = false;
        this._pathCompleter = new Gio.FilenameCompleter();
        this._pathCompleter.set_dirs_only(false);
        this.lastAcResults = [];
        this.settings.bind("search-filesystem", "searchFilesystem");
        this.contextMenu = null;
        this.lastSelectedCategory = null;

        // We shouldn't need to call refreshAll() here... since we get a "icon-theme-changed" signal when CSD starts.
        // The reason we do is in case the Cinnamon icon theme is the same as the one specificed in GTK itself (in .config)
        // In that particular case we get no signal at all.
        this.refreshId = 0;
        this.refreshMask = REFRESH_ALL_MASK;
        this._doRefresh();

        this.set_show_label_in_vertical_panels(false);
    }

    _updateShowIcons(container, show) {
        Util.each(container.get_children(), c => {
            if (!(c instanceof SimpleMenuItem))
                return;
            if (c.icon)
                c.icon.visible = show;
        })
    }

    _updateKeybinding() {
        Main.keybindingManager.addHotKey("overlay-key-" + this.instance_id, this.overlayKey, () => {
            if (!Main.overview.visible && !Main.expo.visible)
                this.menu.toggle_with_options(this.enableAnimation);
        });
    }

    queueRefresh(refreshFlags) {
        if (!refreshFlags)
            return;
        this.refreshMask |= refreshFlags;
        if (this.refreshId)
            Mainloop.source_remove(this.refreshId);
        this.refreshId = Mainloop.timeout_add(500, () => this._doRefresh(), Mainloop.PRIORITY_LOW);
    }

    _doRefresh() {
        this.refreshId = 0;
        if (this.refreshMask === 0)
            return;

        let m = this.refreshMask;
        if ((m & RefreshFlags.APP) === RefreshFlags.APP)
            this._refreshApps();
        if ((m & RefreshFlags.FAV) === RefreshFlags.FAV)
            this._refreshFavs();
        if ((m & RefreshFlags.SYSTEM) === RefreshFlags.SYSTEM)
            this._refreshSystemButtons();
        if ((m & RefreshFlags.PLACE) === RefreshFlags.PLACE)
            this._refreshPlaces();
        if ((m & RefreshFlags.RECENT) === RefreshFlags.RECENT)
            this._refreshRecent();

        this.refreshMask = 0;

        // recent category is always last
        if (this.recentButton)
            this.categoriesBox.set_child_at_index(this.recentButton, -1);

        // places is before recents, or last in list if recents is disabled/not generated
        if (this.placesButton) {
            if (this.recentButton)
                this.categoriesBox.set_child_below_sibling(this.placesButton, this.recentButton);
            else
                this.categoriesBox.set_child_at_index(this.placesButton, -1);
        }

        this._resizeApplicationsBox();
    }

    openMenu() {
        if (!this._applet_context_menu.isOpen) {
            this.menu.open(this.enableAnimation);
        }
    }

    _clearDelayCallbacks() {
        if (this._appletHoverDelayId > 0) {
            Mainloop.source_remove(this._appletHoverDelayId);
            this._appletHoverDelayId = 0;
        }
        if (this._appletLeaveEventId > 0) {
            this.actor.disconnect(this._appletLeaveEventId);
            this._appletLeaveEventId = 0;
        }

        return false;
    }

    _updateActivateOnHover() {
        if (this._appletEnterEventId > 0) {
            this.actor.disconnect(this._appletEnterEventId);
            this._appletEnterEventId = 0;
        }

        this._clearDelayCallbacks();

        if (!this.activateOnHover)
            return;

        this._appletEnterEventId = this.actor.connect('enter-event', () => {
            if (this.hover_delay_ms > 0) {
                this._appletLeaveEventId = this.actor.connect('leave-event', () => { this._clearDelayCallbacks });
                this._appletHoverDelayId = Mainloop.timeout_add(this.hover_delay_ms,
                    () => {
                        this.openMenu();
                        this._clearDelayCallbacks();
                    });
            } else {
                this.openMenu();
            }
        });
    }

    _recalc_height() {
        let scrollBoxHeight = (this.leftBox.get_allocation_box().y2-this.leftBox.get_allocation_box().y1) -
                               (this.searchBox.get_allocation_box().y2-this.searchBox.get_allocation_box().y1);

        this.applicationsScrollBox.style = "height: "+scrollBoxHeight / global.ui_scale +"px;";
        let monitor = Main.layoutManager.monitors[this.panel.monitorIndex];
        let minSize = Math.max(this.favBoxMinHeight * global.ui_scale, this.categoriesBox.height - this.systemButtonsBox.height);
        let maxSize = monitor.height - (this.systemButtonsBox.height * 2);
        let size = Math.min(minSize, maxSize);
        this.favoritesScrollBox.set_height(size);
    }

    on_orientation_changed (orientation) {
        this._updateIconAndLabel();
    }

    on_applet_removed_from_panel () {
        Main.keybindingManager.removeHotKey("overlay-key-" + this.instance_id);
    }

    // settings button callback
    _launch_editor() {
        Util.spawnCommandLine("cinnamon-menu-editor");
    }

    on_applet_clicked(event) {
        this.menu.toggle_with_options(this.enableAnimation);
    }

    _onOpenStateChanged(open) {
        if (open) {
            this.actor.add_style_pseudo_class('active');
            global.stage.set_key_focus(this.searchEntry);
            this._selectedItemIndex = null;
            this._activeContainer = null;
            this._activeActor = null;

            this.lastSelectedCategory = null;

            let n = Math.min(this._applicationsButtons.length,
                             INITIAL_BUTTON_LOAD);
            for (let i = 0; i < n; i++) {
                this._applicationsButtons[i].show();
            }
            this._allAppsCategoryButton.style_class = "menu-category-button-selected";

            Mainloop.idle_add(() => { this._initial_cat_selection(n) });
        } else {
            this.actor.remove_style_pseudo_class('active');
            if (this.searchActive) {
                this.resetSearch();
            }
            this.selectedAppTitle.set_text("");
            this.selectedAppDescription.set_text("");
            this._previousTreeSelectedActor = null;
            this._previousSelectedActor = null;
            this.closeContextMenu(false);

            this._clearAllSelections(true);
            this._scrollToButton(null, this.favoritesScrollBox);
            this.categoriesBox.stopInhibit();
        }
    }

    _initial_cat_selection (start_index) {
        let n = this._applicationsButtons.length;
        for (let i = start_index; i < n; i++) {
            this._applicationsButtons[i].show();
        }
    }

    destroy() {
        this.actor._delegate = null;
        this.menu.destroy();
        this.actor.destroy();
        this.emit('destroy');
    }

    _favboxtoggle() {
        if (!this.favBoxShow) {
            this.leftPane.hide();
        } else {
            this.leftPane.show();
        }
    }

    _updateIconAndLabel(){
        try {
            if (this.menuCustom) {
                if (this.menuIcon == "") {
                    this.set_applet_icon_name("");
                } else if (GLib.path_is_absolute(this.menuIcon) && GLib.file_test(this.menuIcon, GLib.FileTest.EXISTS)) {
                    if (this.menuIcon.search("-symbolic") != -1)
                        this.set_applet_icon_symbolic_path(this.menuIcon);
                    else
                        this.set_applet_icon_path(this.menuIcon);
                } else if (Gtk.IconTheme.get_default().has_icon(this.menuIcon)) {
                    if (this.menuIcon.search("-symbolic") != -1)
                        this.set_applet_icon_symbolic_name(this.menuIcon);
                    else
                        this.set_applet_icon_name(this.menuIcon);
                }
            } else {
                let icon_name = global.settings.get_string('app-menu-icon-name');
                if (icon_name.search("-symbolic") != -1) {
                    this.set_applet_icon_symbolic_name(icon_name);
                }
                else {
                    this.set_applet_icon_name(icon_name);
                }
            }
        } catch(e) {
            global.logWarning("Could not load icon file \""+this.menuIcon+"\" for menu button");
        }

        // Hide the icon box if the icon name/path is empty
        if ((this.menuCustom && this.menuIcon == "") || (!this.menuCustom && global.settings.get_string('app-menu-icon-name') == "")){
            this._applet_icon_box.hide();
        } else {
            this._applet_icon_box.show();
        }

        // Hide the menu label in vertical panels
        if (this._orientation == St.Side.LEFT || this._orientation == St.Side.RIGHT)
        {
            this.set_applet_label("");
        }
        else {
            if (this.menuCustom) {
                if (this.menuLabel != "")
                    this.set_applet_label(_(this.menuLabel));
                else
                    this.set_applet_label("");
            }
            else {
                this.set_applet_label(global.settings.get_string('app-menu-label'));
            }
        }
    }

    _contextMenuOpenStateChanged(menu) {
        if (menu.isOpen) {
            this._activeContextMenuParent = menu.sourceActor;
            this._scrollToButton(menu);
        } else {
            this._activeContextMenuItem = null;
            this._activeContextMenuParent = null;
            menu.sourceActor = null;
        }
    }

    toggleContextMenu(button) {
        if (!button.withMenu)
            return;

        if (!this.contextMenu) {
            let menu = new PopupMenu.PopupSubMenu(null); // hack: creating without actor
            menu.actor.set_style_class_name('menu-context-menu');
            menu.connect('open-state-changed', (menu) => this._contextMenuOpenStateChanged(menu));
            this.contextMenu = menu;
            this.applicationsBox.add_actor(menu.actor);
        } else if (this.contextMenu.isOpen &&
                   this.contextMenu.sourceActor != button) {
            this.contextMenu.close();
        }

        if (!this.contextMenu.isOpen) {
            this.contextMenu.box.destroy_all_children();
            this.applicationsBox.set_child_above_sibling(this.contextMenu.actor, button);
            this.contextMenu.sourceActor = button;
            button.populateMenu(this.contextMenu);
        }

        this.contextMenu.toggle();
    }

    _navigateContextMenu(button, symbol, ctrlKey) {
        if (symbol === Clutter.KEY_Menu || symbol === Clutter.Escape ||
            (ctrlKey && (symbol === Clutter.KEY_Return || symbol === Clutter.KP_Enter))) {
            this.toggleContextMenu(button);
            return;
        }

        let minIndex = 0;
        let goUp = symbol === Clutter.KEY_Up;
        let nextActive = null;
        let menuItems = this.contextMenu._getMenuItems(); // The context menu items

        // The first context menu item of a RecentButton is used just as a label.
        // So remove it from the iteration.
        if (button && button instanceof RecentButton) {
            minIndex = 1;
        }

        let menuItemsLength = menuItems.length;

        switch (symbol) {
            case Clutter.KEY_Page_Up:
                this._activeContextMenuItem = menuItems[minIndex];
                this._activeContextMenuItem.setActive(true);
                return;
            case Clutter.KEY_Page_Down:
                this._activeContextMenuItem = menuItems[menuItemsLength - 1];
                this._activeContextMenuItem.setActive(true);
                return;
        }

        if (!this._activeContextMenuItem) {
            if (symbol === Clutter.KEY_Return || symbol === Clutter.KP_Enter) {
                button.activate();
            } else {
                this._activeContextMenuItem = menuItems[goUp ? menuItemsLength - 1 : minIndex];
                this._activeContextMenuItem.setActive(true);
            }
            return;
        } else if (this._activeContextMenuItem &&
            (symbol === Clutter.KEY_Return || symbol === Clutter.KP_Enter)) {
            this._activeContextMenuItem.activate();
            this._activeContextMenuItem = null;
            return;
        }

        for (let i = minIndex; i < menuItemsLength; i++) {
            if (menuItems[i] === this._activeContextMenuItem) {
                let nextActiveIndex = (goUp ? i - 1 : i + 1);

                if (nextActiveIndex < minIndex) {
                    nextActiveIndex = menuItemsLength - 1;
                } else if (nextActiveIndex > menuItemsLength - 1) {
                    nextActiveIndex = minIndex;
                }

                nextActive = menuItems[nextActiveIndex];
                nextActive.setActive(true);
                this._activeContextMenuItem = nextActive;

                break;
            }
        }
    }

    _onMenuKeyPress(actor, event) {
        let symbol = event.get_key_symbol();
        let item_actor;
        let index = 0;
        this.applicationsBox.reloadVisible();
        this.categoriesBox.reloadVisible();
        this.favoritesBox.reloadVisible();
        this.systemButtonsBox.reloadVisible();

        let keyCode = event.get_key_code();
        let modifierState = Cinnamon.get_event_state(event);

        /* check for a keybinding and quit early, otherwise we get a double hit
           of the keybinding callback */
        let action = global.display.get_keybinding_action(keyCode, modifierState);

        if (action == Meta.KeyBindingAction.CUSTOM) {
            return true;
        }

        index = this._selectedItemIndex;

        let ctrlKey = modifierState & Clutter.ModifierType.CONTROL_MASK;

        // If a context menu is open, hijack keyboard navigation and concentrate on the context menu.
        if (this._activeContextMenuParent &&
            this._activeContainer === this.applicationsBox) {
            let continueNavigation = false;
            switch (symbol) {
                case Clutter.KEY_Up:
                case Clutter.KEY_Down:
                case Clutter.KEY_Return:
                case Clutter.KP_Enter:
                case Clutter.KEY_Menu:
                case Clutter.KEY_Page_Up:
                case Clutter.KEY_Page_Down:
                case Clutter.Escape:
                    this._navigateContextMenu(this._activeContextMenuParent, symbol, ctrlKey);
                    break;
                case Clutter.KEY_Right:
                case Clutter.KEY_Left:
                case Clutter.Tab:
                case Clutter.ISO_Left_Tab:
                    continueNavigation = true;
                    break;
            }
            if (!continueNavigation)
                return true;
        }

        let navigationKey = true;
        let whichWay = "none";

        switch (symbol) {
            case Clutter.KEY_Up:
                whichWay = "up";
                if (this._activeContainer === this.favoritesBox && ctrlKey &&
                    (this.favoritesBox.get_child_at_index(index)) instanceof FavoritesButton)
                    navigationKey = false;
                break;
            case Clutter.KEY_Down:
                whichWay = "down";
                if (this._activeContainer === this.favoritesBox && ctrlKey &&
                    (this.favoritesBox.get_child_at_index(index)) instanceof FavoritesButton)
                    navigationKey = false;
                break;
            case Clutter.KEY_Page_Up:
                whichWay = "top"; break;
            case Clutter.KEY_Page_Down:
                whichWay = "bottom"; break;
            case Clutter.KEY_Right:
                if (!this.searchActive)
                    whichWay = "right";
                if (this._activeContainer === this.applicationsBox)
                    whichWay = "none";
                else if (this._activeContainer === this.categoriesBox && this.noRecentDocuments &&
                         (this.categoriesBox.get_child_at_index(index)).categoryId === "recent")
                    whichWay = "none";
                break;
            case Clutter.KEY_Left:
                if (!this.searchActive)
                    whichWay = "left";
                if (this._activeContainer === this.favoritesBox || this._activeContainer === this.systemButtonsBox)
                    whichWay = "none";
                else if (!this.favBoxShow &&
                            (this._activeContainer === this.categoriesBox || this._activeContainer === null))
                    whichWay = "none";
                break;
            case Clutter.Tab:
                if (!this.searchActive)
                    whichWay = "right";
                else
                    navigationKey = false;
                break;
            case Clutter.ISO_Left_Tab:
                if (!this.searchActive)
                    whichWay = "left";
                else
                    navigationKey = false;
                break;
            default:
                navigationKey = false;
        }

        if (navigationKey) {
            switch (this._activeContainer) {
                case null:
                    switch (whichWay) {
                        case "up":
                            this._activeContainer = this.categoriesBox;
                            item_actor = this.categoriesBox.getLastVisible();
                            this._scrollToButton();
                            break;
                        case "down":
                            this._activeContainer = this.categoriesBox;
                            item_actor = this.categoriesBox.getFirstVisible();
                            item_actor = this.categoriesBox.getNextVisible(item_actor);
                            this._scrollToButton();
                            break;
                        case "right":
                            this._activeContainer = this.applicationsBox;
                            item_actor = this.applicationsBox.getFirstVisible();
                            this._scrollToButton();
                            break;
                        case "left":
                            if (this.favBoxShow) {
                                this._activeContainer = this.favoritesBox;
                                item_actor = this.favoritesBox.getFirstVisible();
                            } else {
                                this._activeContainer = this.applicationsBox;
                                item_actor = this.applicationsBox.getFirstVisible();
                                this._scrollToButton();
                            }
                            break;
                        case "top":
                            this._activeContainer = this.categoriesBox;
                            item_actor = this.categoriesBox.getFirstVisible();
                            this._scrollToButton();
                            break;
                        case "bottom":
                            this._activeContainer = this.categoriesBox;
                            item_actor = this.categoriesBox.getLastVisible();
                            this._scrollToButton();
                            break;
                    }
                    break;
                case this.categoriesBox:
                    switch (whichWay) {
                        case "up":
                            this._previousTreeSelectedActor = this.categoriesBox.get_child_at_index(index);
                            this._previousTreeSelectedActor.isHovered = false;
                            item_actor = this.categoriesBox.getPrevVisible(this._activeActor);
                            this._scrollToButton();
                            break;
                        case "down":
                            this._previousTreeSelectedActor = this.categoriesBox.get_child_at_index(index);
                            this._previousTreeSelectedActor.isHovered = false;
                            item_actor = this.categoriesBox.getNextVisible(this._activeActor);
                            this._scrollToButton();
                            break;
                        case "right":
                            if ((this.categoriesBox.get_child_at_index(index)).categoryId === "recent" &&
                                this.noRecentDocuments) {
                                if(this.favBoxShow) {
                                    this._previousSelectedActor = this.categoriesBox.get_child_at_index(index);
                                    item_actor = this.favoritesBox.getFirstVisible();
                                } else {
                                    item_actor = this.categoriesBox.get_child_at_index(index);
                                }
                            }
                            else {
                                item_actor = (this._previousVisibleIndex != null) ?
                                    this.applicationsBox.getVisibleItem(this._previousVisibleIndex) :
                                    this.applicationsBox.getFirstVisible();
                            }
                            break;
                        case "left":
                            if(this.favBoxShow) {
                                this._previousSelectedActor = this.categoriesBox.get_child_at_index(index);
                                item_actor = this.favoritesBox.getFirstVisible();
                                this._scrollToButton(null, this.favoritesScrollBox);
                            } else {
                                if ((this.categoriesBox.get_child_at_index(index)).categoryId === "recent" &&
                                    this.noRecentDocuments) {
                                    item_actor = this.categoriesBox.get_child_at_index(index);
                                } else {
                                    item_actor = (this._previousVisibleIndex != null) ?
                                        this.applicationsBox.getVisibleItem(this._previousVisibleIndex) :
                                        this.applicationsBox.getFirstVisible();
                                }
                            }
                            break;
                        case "top":
                            this._previousTreeSelectedActor = this.categoriesBox.get_child_at_index(index);
                            this._previousTreeSelectedActor.isHovered = false;
                            item_actor = this.categoriesBox.getFirstVisible();
                            this._scrollToButton();
                            break;
                        case "bottom":
                            this._previousTreeSelectedActor = this.categoriesBox.get_child_at_index(index);
                            this._previousTreeSelectedActor.isHovered = false;
                            item_actor = this.categoriesBox.getLastVisible();
                            this._scrollToButton();
                            break;
                    }
                    break;
                case this.applicationsBox:
                    switch (whichWay) {
                        case "up":
                            this._previousSelectedActor = this.applicationsBox.get_child_at_index(index);
                            item_actor = this.applicationsBox.getPrevVisible(this._previousSelectedActor);
                            this._previousVisibleIndex = this.applicationsBox.getVisibleIndex(item_actor);
                            this._scrollToButton(item_actor);
                            break;
                        case "down":
                            this._previousSelectedActor = this.applicationsBox.get_child_at_index(index);
                            item_actor = this.applicationsBox.getNextVisible(this._previousSelectedActor);
                            this._previousVisibleIndex = this.applicationsBox.getVisibleIndex(item_actor);
                            this._scrollToButton(item_actor);
                            break;
                        case "right":
                            this._previousSelectedActor = this.applicationsBox.get_child_at_index(index);
                            item_actor = (this._previousTreeSelectedActor != null) ?
                                this._previousTreeSelectedActor :
                                this.categoriesBox.getFirstVisible();
                            this._previousTreeSelectedActor = item_actor;
                            index = item_actor.get_parent().getAbsoluteIndexOfChild(item_actor);

                            if (this.favBoxShow) {
                                this._buttonEnterEvent(item_actor);
                                this._previousSelectedActor = this.categoriesBox.get_child_at_index(index);
                                item_actor = this.favoritesBox.getFirstVisible();
                            }
                            break;
                        case "left":
                            this._previousSelectedActor = this.applicationsBox.get_child_at_index(index);
                            item_actor = (this._previousTreeSelectedActor != null) ?
                                this._previousTreeSelectedActor :
                                this.categoriesBox.getFirstVisible();
                            this._previousTreeSelectedActor = item_actor;
                            break;
                        case "top":
                            item_actor = this.applicationsBox.getFirstVisible();
                            this._previousVisibleIndex = this.applicationsBox.getVisibleIndex(item_actor);
                            this._scrollToButton(item_actor);
                            break;
                        case "bottom":
                            item_actor = this.applicationsBox.getLastVisible();
                            this._previousVisibleIndex = this.applicationsBox.getVisibleIndex(item_actor);
                            this._scrollToButton(item_actor);
                            break;
                    }
                    break;
                case this.favoritesBox:
                    switch (whichWay) {
                        case "up":
                            this._previousSelectedActor = this.favoritesBox.get_child_at_index(index);
                            if (this._previousSelectedActor === this.favoritesBox.getFirstVisible()) {
                                item_actor = this.systemButtonsBox.getLastVisible();
                            } else {
                                item_actor = this.favoritesBox.getPrevVisible(this._previousSelectedActor);
                                this._scrollToButton(item_actor, this.favoritesScrollBox);
                            }
                            break;
                        case "down":
                            this._previousSelectedActor = this.favoritesBox.get_child_at_index(index);
                            if (this._previousSelectedActor === this.favoritesBox.getLastVisible()) {
                                item_actor = this.systemButtonsBox.getFirstVisible();
                            } else {
                                item_actor = this.favoritesBox.getNextVisible(this._previousSelectedActor);
                                this._scrollToButton(item_actor, this.favoritesScrollBox);
                            }
                            break;
                        case "right":
                            item_actor = (this._previousTreeSelectedActor != null) ?
                                this._previousTreeSelectedActor :
                                this.categoriesBox.getFirstVisible();
                            this._previousTreeSelectedActor = item_actor;
                            break;
                        case "left":
                            item_actor = (this._previousTreeSelectedActor != null) ?
                                this._previousTreeSelectedActor :
                                this.categoriesBox.getFirstVisible();
                            this._previousTreeSelectedActor = item_actor;
                            index = item_actor.get_parent().getAbsoluteIndexOfChild(item_actor);

                            this._buttonEnterEvent(item_actor);
                            item_actor = (this._previousVisibleIndex != null) ?
                                this.applicationsBox.getVisibleItem(this._previousVisibleIndex) :
                                this.applicationsBox.getFirstVisible();
                            break;
                        case "top":
                            item_actor = this.favoritesBox.getFirstVisible();
                            break;
                        case "bottom":
                            item_actor = this.favoritesBox.getLastVisible();
                            break;
                    }
                    break;
                case this.systemButtonsBox:
                    switch (whichWay) {
                        case "up":
                            this._previousSelectedActor = this.systemButtonsBox.get_child_at_index(index);
                            if (this._previousSelectedActor === this.systemButtonsBox.getFirstVisible()) {
                                item_actor = this.favoritesBox.getLastVisible();
                                this._scrollToButton(item_actor, this.favoritesScrollBox);
                            } else {
                                item_actor = this.systemButtonsBox.getPrevVisible(this._previousSelectedActor);
                            }
                            break;
                        case "down":
                            this._previousSelectedActor = this.systemButtonsBox.get_child_at_index(index);
                            if (this._previousSelectedActor === this.systemButtonsBox.getLastVisible()) {
                                item_actor = this.favoritesBox.getFirstVisible();
                                this._scrollToButton(null, this.favoritesScrollBox);
                            } else {
                                item_actor = this.systemButtonsBox.getNextVisible(this._previousSelectedActor);
                            }
                            break;
                        case "right":
                            item_actor = (this._previousTreeSelectedActor != null) ?
                                this._previousTreeSelectedActor :
                                this.categoriesBox.getFirstVisible();
                            this._previousTreeSelectedActor = item_actor;
                            break;
                        case "left":
                            item_actor = (this._previousTreeSelectedActor != null) ?
                                this._previousTreeSelectedActor :
                                this.categoriesBox.getFirstVisible();
                            this._previousTreeSelectedActor = item_actor;
                            index = item_actor.get_parent().getAbsoluteIndexOfChild(item_actor);

                            this._buttonEnterEvent(item_actor);
                            item_actor = (this._previousVisibleIndex != null) ?
                                this.applicationsBox.getVisibleItem(this._previousVisibleIndex) :
                                this.applicationsBox.getFirstVisible();
                            break;
                        case "top":
                            item_actor = this.systemButtonsBox.getFirstVisible();
                            break;
                        case "bottom":
                            item_actor = this.systemButtonsBox.getLastVisible();
                            break;
                    }
                    break;
                default:
                    break;
            }
            if (!item_actor)
                return false;
            index = item_actor.get_parent().getAbsoluteIndexOfChild(item_actor);
        } else {
            if ((this._activeContainer && this._activeContainer !== this.categoriesBox) && (symbol === Clutter.KEY_Return || symbol === Clutter.KP_Enter)) {
                if (!ctrlKey) {
                    item_actor = this._activeContainer.get_child_at_index(this._selectedItemIndex);
                    item_actor.activate();
                } else if (ctrlKey && this._activeContainer === this.applicationsBox) {
                    item_actor = this.applicationsBox.get_child_at_index(this._selectedItemIndex);
                    this.toggleContextMenu(item_actor);
                }
                return true;
            } else if (this._activeContainer === this.applicationsBox && symbol === Clutter.KEY_Menu) {
                item_actor = this.applicationsBox.get_child_at_index(this._selectedItemIndex);
                this.toggleContextMenu(item_actor);
                return true;
            } else if (!this.searchActive && this._activeContainer === this.favoritesBox && symbol === Clutter.Delete) {
                item_actor = this.favoritesBox.get_child_at_index(this._selectedItemIndex);
                if (item_actor instanceof FavoritesButton) {
                    let favorites = AppFavorites.getAppFavorites().getFavorites();
                    let numFavorites = favorites.length;
                    AppFavorites.getAppFavorites().removeFavorite(item_actor.app.get_id());
                    if (this._selectedItemIndex == (numFavorites-1))
                        item_actor = this.favoritesBox.get_child_at_index(this._selectedItemIndex-1);
                    else
                        item_actor = this.favoritesBox.get_child_at_index(this._selectedItemIndex);
                }
            } else if (this._activeContainer === this.favoritesBox &&
                        (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Up) && ctrlKey &&
                        (this.favoritesBox.get_child_at_index(index)) instanceof FavoritesButton) {
                item_actor = this.favoritesBox.get_child_at_index(this._selectedItemIndex);
                let id = item_actor.app.get_id();
                let appFavorites = AppFavorites.getAppFavorites();
                let favorites = appFavorites.getFavorites();
                let numFavorites = favorites.length;
                let favPos = 0;
                if (this._selectedItemIndex == (numFavorites-1) && symbol === Clutter.KEY_Down)
                    favPos = 0;
                else if (this._selectedItemIndex == 0 && symbol === Clutter.KEY_Up)
                    favPos = numFavorites-1;
                else if (symbol === Clutter.KEY_Down)
                    favPos = this._selectedItemIndex + 1;
                else
                    favPos = this._selectedItemIndex - 1;
                appFavorites.moveFavoriteToPos(id, favPos);
                item_actor = this.favoritesBox.get_child_at_index(favPos);
                this._scrollToButton(item_actor, this.favoritesScrollBox);
            } else if (this.searchFilesystem && (this._fileFolderAccessActive || symbol === Clutter.slash)) {
                if (symbol === Clutter.Return || symbol === Clutter.KP_Enter) {
                    if (launchFile(this.searchEntry.get_text())) {
                        this.menu.close();
                    }
                    return true;
                }
                if (symbol === Clutter.Escape) {
                    this.searchEntry.set_text('');
                    this._fileFolderAccessActive = false;
                }
                if (symbol === Clutter.slash) {
                    // Need preload data before get completion. GFilenameCompleter load content of parent directory.
                    // Parent directory for /usr/include/ is /usr/. So need to add fake name('a').
                    let text = this.searchEntry.get_text().concat('/a');
                    let prefix;
                    if (!text.includes(' '))
                        prefix = text;
                    else
                        prefix = text.substr(text.lastIndexOf(' ') + 1);
                    this._getCompletion(prefix);

                    return false;
                }
                if (symbol === Clutter.Tab) {
                    let text = actor.get_text();
                    let prefix;
                    if (!text.includes(' '))
                        prefix = text;
                    else
                        prefix = text.substr(text.lastIndexOf(' ') + 1);
                    let postfix = this._getCompletion(prefix);
                    if (postfix != null && postfix.length > 0) {
                        actor.insert_text(postfix, -1);
                        actor.set_cursor_position(text.length + postfix.length);
                        if (postfix[postfix.length - 1] == '/')
                            this._getCompletion(text + postfix + 'a');
                    }
                    return true;
                }
                if (symbol === Clutter.ISO_Left_Tab) {
                    return true;
                }
                return false;
            } else if (symbol === Clutter.Tab || symbol === Clutter.ISO_Left_Tab) {
                return true;
            } else {
                return false;
            }
        }

        this.selectedAppTitle.set_text("");
        this.selectedAppDescription.set_text("");

        this._selectedItemIndex = index;
        if (!item_actor || item_actor === this.searchEntry) {
            return false;
        }
        this._buttonEnterEvent(item_actor);
        return true;
    }

    _buttonEnterEvent(button) {
        let parent = button.get_parent();
        if (this._activeContainer === this.categoriesBox && parent !== this._activeContainer) {
            this._previousTreeSelectedActor = this._activeActor;
            this._previousSelectedActor = null;
        }
        if (this._previousTreeSelectedActor && this._activeContainer !== this.categoriesBox &&
                parent !== this._activeContainer && button !== this._previousTreeSelectedActor && !this.searchActive) {
            this._previousTreeSelectedActor.style_class = "menu-category-button";
        }
        if (parent != this._activeContainer) {
            parent.reloadVisible();
        }
        let _maybePreviousActor = this._activeActor;
        if (_maybePreviousActor && this._activeContainer !== this.categoriesBox) {
            this._previousSelectedActor = _maybePreviousActor;
            this._clearPrevSelection();
        }
        if (parent === this.categoriesBox && !this.searchActive) {
            this._previousSelectedActor = _maybePreviousActor;
            this._clearPrevCatSelection();
        }
        this._activeContainer = parent;
        this._activeActor = button;

        if (this._activeContainer) {
            this._selectedItemIndex = this._activeContainer.getAbsoluteIndexOfChild(this._activeActor);
        }

        let isFav = false;
        if (button instanceof CategoryButton) {
            if (this.searchActive)
                return;
            button.isHovered = true;
            this._clearPrevCatSelection(button);
            this._select_category(button.categoryId);
            this.categoriesBox.startInhibit();
        } else {
            this._previousVisibleIndex = parent.getVisibleIndex(button);

            isFav = button instanceof FavoritesButton || button instanceof SystemButton;
            if (!isFav)
                this._clearPrevSelection(button);
            this.selectedAppTitle.set_text(button.name);
            this.selectedAppDescription.set_text(button.description);
        }

        if (isFav)
            button.add_style_pseudo_class("hover");
        else
            button.set_style_class_name(`${button.styleClass}-selected`);
    }

    _buttonLeaveEvent (button) {
        if (button instanceof CategoryButton) {
            if (this._previousTreeSelectedActor === null) {
                this._previousTreeSelectedActor = button;
            } else {
                let prevIdx = this.categoriesBox.getVisibleIndex(this._previousTreeSelectedActor);
                let nextIdx = this.categoriesBox.getVisibleIndex(button);

                if (Math.abs(prevIdx - nextIdx) <= 1) {
                    this._previousTreeSelectedActor = button;
                }
            }
            button.isHovered = false;
        } else {
            this._previousSelectedActor = button;
            this.selectedAppTitle.set_text("");
            this.selectedAppDescription.set_text("");

            // category unselects are handled when the category actually changes
            if (button instanceof FavoritesButton || button instanceof SystemButton)
                button.remove_style_pseudo_class("hover");
            else
                button.set_style_class_name(button.styleClass);
        }
    }

    _clearPrevSelection(actor) {
        if (this._previousSelectedActor
            && !this._previousSelectedActor.is_finalized()
            && this._previousSelectedActor != actor) {
            if (this._previousSelectedActor instanceof FavoritesButton ||
                this._previousSelectedActor instanceof SystemButton)
                this._previousSelectedActor.remove_style_pseudo_class("hover");
            else if (!(this._previousSelectedActor instanceof CategoryButton))
                this._previousSelectedActor.style_class = "menu-application-button";
        }
    }

    _clearPrevCatSelection(actor) {
        if (this._previousTreeSelectedActor && this._previousTreeSelectedActor != actor) {
            this._previousTreeSelectedActor.style_class = "menu-category-button";

            if (this._previousTreeSelectedActor)
                this._buttonLeaveEvent(this._previousTreeSelectedActor);

            if (actor !== undefined) {
                this._previousVisibleIndex = null;
                this._previousTreeSelectedActor = actor;
            }
        } else {
            this.categoriesBox.get_children().forEach(child => child.style_class = "menu-category-button");
        }
    }

    _refreshPlaces () {
        for (let i = 0; i < this._placesButtons.length; i ++) {
            this._placesButtons[i].destroy();
        }

        this._placesButtons = [];

        if (!this.showPlaces) {
            for (let i = 0; i < this._categoryButtons.length; i++) {
                if (this._categoryButtons[i].categoryId === 'place') {
                    this._categoryButtons[i].destroy();
                    this._categoryButtons.splice(i, 1);
                    this.placesButton = null;
                    break;
                }
            }
            return;
        }

        // Now generate Places category and places buttons and add to the list
        if (!this.placesButton) {
            this.placesButton = new CategoryButton(this, 'place', _('Places'),  'folder');
            this._categoryButtons.push(this.placesButton);
            this.categoriesBox.add_actor(this.placesButton);
        }

        // places go after the last applicationbutton
        let sibling = this._applicationsButtons[this._applicationsButtons.length - 1];
        Util.each(Main.placesManager.getAllPlaces(), place => {
            let button = new PlaceButton(this, place);
            this._placesButtons.push(button);
            this.applicationsBox.insert_child_below(button, sibling);
            button.visible = this.menu.isOpen;
            sibling = button;
        });

        this._resizeApplicationsBox();
    }

    _refreshRecent () {
        for (let i = 0; i < this._recentButtons.length; i++) {
            this._recentButtons[i].destroy();
        }

        this._recentButtons = [];

        if (!this.showRecents || !this.privacy_settings.get_boolean(REMEMBER_RECENT_KEY)) {
            for (let i = 0; i < this._categoryButtons.length; i++) {
                if (this._categoryButtons[i].categoryId === 'recent') {
                    this._categoryButtons[i].destroy();
                    this._categoryButtons.splice(i, 1);
                    this.recentButton = null;
                    break;
                }
            }
            return;
        }

        if (!this.recentButton) {
            this.recentButton = new CategoryButton(this, 'recent', _('Recent Files'), 'folder-recent');
            this._categoryButtons.push(this.recentButton);
            this.categoriesBox.add_actor(this.recentButton);
        }

        let recents = this.RecentManager._infosByTimestamp.filter(info => !info.name.startsWith("."));
        if (recents.length > 0) {
            this.noRecentDocuments = false;
            Util.each(recents, (info) => {
                let button = new RecentButton(this, info);
                this._recentButtons.push(button);
                this.applicationsBox.add_actor(button);
                button.visible = this.menu.isOpen;
            });

            let button = new SimpleMenuItem(this, { name: _("Clear list"),
                                                    description: ("Clear all recent documents"),
                                                        type: 'recent-clear',
                                                    styleClass: 'menu-application-button' });
            button.addIcon(APPLICATION_ICON_SIZE, 'edit-clear', null, true);
            button.addLabel("", 'menu-application-button-label');
            button.label.clutter_text.set_markup(`<b>${button.name}</b>`);
            button.activate = () => {
                this.menu.close();
                (new Gtk.RecentManager()).purge_items();
            };

            if (!this.showApplicationIcons)
                button.icon.visible = false;

            this._recentButtons.push(button);
            this.applicationsBox.add_actor(button);
            button.visible = this.menu.isOpen;
        } else {
            this.noRecentDocuments = true;
            let button = new SimpleMenuItem(this, { name: _("No recent documents"),
                                                    type: 'no-recent',
                                                    styleClass: 'menu-application-button',
                                                    reactive: false,
                                                    activatable: false });
            button.addLabel(button.name, 'menu-application-button-label');
            this._recentButtons.push(button);
            this.applicationsBox.add_actor(button);
            button.visible = this.menu.isOpen;
        }

        this._resizeApplicationsBox();
    }

    _refreshApps() {
        /* iterate in reverse, so multiple splices will not upset
         * the remaining elements */
        for (let i = this._categoryButtons.length - 1; i > -1; i--) {
            let b = this._categoryButtons[i];
            if (b === this._allAppsCategoryButton ||
                ['place', 'recent'].includes(b.categoryId))
                continue;
            this._categoryButtons[i].destroy();
            this._categoryButtons.splice(i, 1);
        }

        this._applicationsButtons.forEach(button => button.destroy());
        this._applicationsButtons = [];

        if (!this._allAppsCategoryButton) {
            this._allAppsCategoryButton = new CategoryButton(this);
            this.categoriesBox.add_actor(this._allAppsCategoryButton);
            this._categoryButtons.push(this._allAppsCategoryButton);
        }

        // grab top level directories and all apps in them
        let [apps, dirs] = getApps();

        // generate all category buttons from top-level directories
        Util.each(dirs, (d) => {
            let categoryButton = new CategoryButton(this, d.get_menu_id(), d.get_name(), d.get_icon());
            this._categoryButtons.push(categoryButton);
            this.categoriesBox.add_actor(categoryButton);
        });

        /* we add them in reverse at index 0 so they are always above places and
         * recent buttons, and below */
        for (let i = apps.length - 1; i > -1; i--) {
            let app = apps[i][0];
            let button = new ApplicationButton(this, app);
            button.category = apps[i][1];
            let appKey = app.get_id() || `${app.get_name()}:${app.get_description()}`;

            // appsWereRefreshed if this is not initial load. on initial load every
            // app is marked known.
            if (this._appsWereRefreshed && !this._knownApps.has(appKey))
                button.highlight();
            else
                this._knownApps.add(appKey);

            this._applicationsButtons.push(button);
            this.applicationsBox.insert_child_at_index(button, 0);
            button.visible = this.menu.isOpen;
        }

        // we expect this array to be in the same order as the child list
        this._applicationsButtons.reverse();
        this._appsWereRefreshed = true;
    }

    _refreshFavs() {
        //Remove all favorites
        this.favoritesBox.destroy_all_children();

        //Load favorites again
        this._favoritesButtons = [];
        let launchers = global.settings.get_strv('favorite-apps');
        for ( let i = 0; i < launchers.length; ++i ) {
            let app = appsys.lookup_app(launchers[i]);
            if (app) {
                let button = new FavoritesButton(this, app);
                this._favoritesButtons[app] = button;
                this.favoritesBox.add(button, { y_align: St.Align.END, y_fill: false });
            }
        }
    }

    _refreshSystemButtons() {
        // Remove all system buttons
        this.systemButtonsBox.destroy_all_children();

        // Load system buttons again
        let button;

        //Lock screen
        button = new SystemButton(this, "system-lock-screen",
                                  _("Lock screen"),
                                  _("Lock the screen"));

        button.activate = () => {
            this.menu.close();

            let screensaver_settings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.screensaver" });
            let screensaver_dialog = Gio.file_new_for_path("/usr/bin/cinnamon-screensaver-command");
            if (screensaver_dialog.query_exists(null)) {
                if (screensaver_settings.get_boolean("ask-for-away-message")) {
                    Util.spawnCommandLine("cinnamon-screensaver-lock-dialog");
                }
                else {
                    Util.spawnCommandLine("cinnamon-screensaver-command --lock");
                }
            }
            else {
                this._screenSaverProxy.LockRemote("");
            }
        };

        this.systemButtonsBox.add(button, { y_align: St.Align.END, y_fill: false });

        //Logout button
        button = new SystemButton(this, "system-log-out",
                                  _("Logout"),
                                  _("Leave the session"));

        button.activate = () => {
            this.menu.close();
            this._session.LogoutRemote(0);
        };

        this.systemButtonsBox.add(button, { y_align: St.Align.END, y_fill: false });

        //Shutdown button
        button = new SystemButton(this, "system-shutdown",
                                  _("Quit"),
                                  _("Shutdown the computer"));

        button.activate = () => {
            this.menu.close();
            this._session.ShutdownRemote();
        };

        this.systemButtonsBox.add(button, { y_align: St.Align.END, y_fill: false });
    }

    _scrollToButton(button, scrollBox = null) {
        if (!scrollBox)
            scrollBox = this.applicationsScrollBox;

        let adj = scrollBox.get_vscroll_bar().get_adjustment();
        if (button) {
            let box = scrollBox.get_allocation_box();
            let boxHeight = box.y2 - box.y1;
            let actorBox = button.get_allocation_box();
            let currentValue = adj.get_value();
            let newValue = currentValue;

            if (currentValue > actorBox.y1 - 10)
                newValue = actorBox.y1 - 10;
            if (boxHeight + currentValue < actorBox.y2 + 10)
                newValue = actorBox.y2 - boxHeight + 10;

            if (newValue != currentValue)
                adj.set_value(newValue);
        } else {
            adj.set_value(0);
        }
    }

    _display() {
        this._activeContainer = null;
        this._activeActor = null;
        let section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(section);

        this.leftPane = new St.BoxLayout({ vertical: true });

        this.leftBox = new St.BoxLayout({ style_class: 'menu-favorites-box', vertical: true });

        this._session = new GnomeSession.SessionManager();
        this._screenSaverProxy = new ScreenSaver.ScreenSaverProxy();

        this.leftPane.add(this.leftBox, { y_align: St.Align.END, y_fill: false });
        this._favboxtoggle();

        let rightPane = new St.BoxLayout({ vertical: true });

        this.searchBox = new St.BoxLayout({ style_class: 'menu-search-box' });

        this.searchEntry = new St.Entry({ name: 'menu-search-entry',
                                     hint_text: _("Type to search..."),
                                     track_hover: true,
                                     can_focus: true });
        this.searchEntry.set_secondary_icon(this._searchInactiveIcon);
        this.searchBox.add(this.searchEntry, {x_fill: true, x_align: St.Align.START, y_align: St.Align.MIDDLE, y_fill: false, expand: true});
        this.searchActive = false;
        this.searchEntryText = this.searchEntry.clutter_text;
        this.searchEntryText.connect('text-changed', () =>  this._onSearchTextChanged());
        this.searchEntryText.connect('key-press-event', (actor, event) => this._onMenuKeyPress(actor, event));
        this._previousSearchPattern = "";

        this.categoriesApplicationsBox = new St.BoxLayout();
        this.categoriesApplicationsBox._delegate = {
            acceptDrop: function(source, actor, x, y, time) {
                if (source instanceof FavoritesButton) {
                    appFavs.removeFavorite(source.appId);
                    source.destroy();
                    return true;
                }
                return false;
            },
            handleDragOver: function (source, actor, x, y, time) {
                if (source instanceof FavoritesButton)
                    return DND.DragMotionResult.POINTING_DROP;

                return DND.DragMotionResult.CONTINUE;
            }
        };
        rightPane.add_actor(this.searchBox);
        rightPane.add_actor(this.categoriesApplicationsBox);

        this.categoriesBox = new CategoriesBox();

        this.applicationsScrollBox = new St.ScrollView({ x_fill: true, y_fill: false, y_align: St.Align.START, style_class: 'vfade menu-applications-scrollbox' });
        this.favoritesScrollBox = new St.ScrollView({
            x_fill: true,
            y_fill: false,
            y_align: St.Align.START,
            style_class: 'vfade menu-favorites-scrollbox'
        });

        this.a11y_settings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.a11y.applications" });
        this.a11y_settings.connect("changed::screen-magnifier-enabled", () => this._updateVFade());
        this.a11y_mag_settings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.a11y.magnifier" });
        this.a11y_mag_settings.connect("changed::mag-factor", () => this._updateVFade());

        this._updateVFade();

        this.settings.bind("enable-autoscroll", "autoscroll_enabled", this._update_autoscroll);
        this._update_autoscroll();

        let vscroll = this.applicationsScrollBox.get_vscroll_bar();
        vscroll.connect('scroll-start', () => { this.menu.passEvents = true });
        vscroll.connect('scroll-stop', () => { this.menu.passEvents = false });

        this.applicationsBox = new SimpleMenuBox({ style_class: 'menu-applications-inner-box', vertical: true });
        this.applicationsBox.add_style_class_name('menu-applications-box'); //this is to support old themes
        this.applicationsScrollBox.add_actor(this.applicationsBox);
        this.applicationsScrollBox.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        this.categoriesApplicationsBox.add_actor(this.categoriesBox);
        this.categoriesApplicationsBox.add_actor(this.applicationsScrollBox);

        this.favoritesBox = new FavoritesBox();
        this.favoritesScrollBox.add_actor(this.favoritesBox);
        this.favoritesScrollBox.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.NEVER);

        this.leftBox.add(this.favoritesScrollBox, {
            y_align: St.Align.END,
            y_fill: false
        });

        this.systemButtonsBox = new SimpleMenuBox({ vertical: true });
        this.leftBox.add(this.systemButtonsBox, { y_align: St.Align.END, y_fill: false });

        this.mainBox = new St.BoxLayout({ style_class: 'menu-applications-outer-box', vertical:false });
        this.mainBox.add_style_class_name('menu-applications-box'); //this is to support old themes

        this.mainBox.add(this.leftPane, { span: 1 });
        this.mainBox.add(rightPane, { span: 1 });
        this.mainBox._delegate = null;

        this.selectedAppBox = new St.BoxLayout({ style_class: 'menu-selected-app-box', vertical: true });

        if (this.selectedAppBox.peek_theme_node() == null ||
            this.selectedAppBox.get_theme_node().get_length('height') == 0)
            this.selectedAppBox.set_height(30 * global.ui_scale);

        this.selectedAppTitle = new St.Label({ style_class: 'menu-selected-app-title', text: "" });
        this.selectedAppBox.add_actor(this.selectedAppTitle);
        this.selectedAppDescription = new St.Label({ style_class: 'menu-selected-app-description', text: "" });
        this.selectedAppBox.add_actor(this.selectedAppDescription);
        this.selectedAppBox._delegate = null;

        section.actor.add(this.mainBox);
        section.actor.add_actor(this.selectedAppBox);

        Mainloop.idle_add(() => { this._clearAllSelections(true) });

        this.menu.actor.connect("allocation-changed", (...args) => { this._on_allocation_changed(...args) });
    }

    _updateVFade() {
        let mag_on = this.a11y_settings.get_boolean("screen-magnifier-enabled") &&
                     this.a11y_mag_settings.get_double("mag-factor") > 1.0;
        if (mag_on) {
            this.applicationsScrollBox.style_class = "menu-applications-scrollbox";
            this.favoritesScrollBox.style_class = "menu-favorites-scrollbox";
        } else {
            this.applicationsScrollBox.style_class = "vfade menu-applications-scrollbox";
            this.favoritesScrollBox.style_class = "vfade menu-favorites-scrollbox";
        }
    }

    _update_autoscroll() {
        this.applicationsScrollBox.set_auto_scrolling(this.autoscroll_enabled);
        this.favoritesScrollBox.set_auto_scrolling(this.autoscroll_enabled);
    }

    _on_allocation_changed(box, flags, data) {
        this._recalc_height();
    }

    _clearAllSelections(hide_apps) {
        let actors = this.applicationsBox.get_children();
        for (let i = 0; i < actors.length; i++) {
            let actor = actors[i];
            actor.style_class = "menu-application-button";
            if (hide_apps) {
                actor.hide();
            }
        }
        actors = this.categoriesBox.get_children();
        for (let i = 0; i < actors.length; i++){
            let actor = actors[i];
            actor.style_class = "menu-category-button";
            actor.show();
        }
        actors = this.favoritesBox.get_children();
        for (let i = 0; i < actors.length; i++){
            let actor = actors[i];
            actor.remove_style_pseudo_class("hover");
            actor.show();
        }
        actors = this.systemButtonsBox.get_children();
        for (let i = 0; i < actors.length; i++){
            let actor = actors[i];
            actor.remove_style_pseudo_class("hover");
            actor.show();
        }
    }

    _select_category (name) {
        if (name === this.lastSelectedCategory)
            return;
        this.lastSelectedCategory = name;
        this._displayButtons(name || 'app');
        this.closeContextMenu(false);
    }

    closeContextMenu(animate) {
        if (!this.contextMenu || !this.contextMenu.isOpen)
            return;

        if (animate)
            this.contextMenu.toggle();
        else
            this.contextMenu.close();
    }

    _resizeApplicationsBox() {
        let width = -1;
        Util.each(this.applicationsBox.get_children(), c => {
            let [min, nat] = c.get_preferred_width(-1.0);
            if (nat > width)
                width = nat;
        });
        this.applicationsBox.set_width(width + 42); // The answer to life...
    }


    /**
     * Reset the ApplicationsBox to a specific category or list of buttons.
     * @param {String} category     (optional) The button type or application category to be displayed.
     * @param {Array} buttons       (optional) A list of existing buttons to show.
     * @param {Array} autoCompletes (optional) A list of autocomplete strings to add buttons for and show.
     */
    _displayButtons(category, buttons=[], autoCompletes=[]){
        /* We only operate on SimpleMenuItems here. If any other menu item types
         * are added, they should be managed independently. */
        Util.each(this.applicationsBox.get_children(), c => {
            if (!(c instanceof SimpleMenuItem))
                return;

            // destroy temporary buttons
            if (['transient', 'search-provider'].includes(c.type)) {
                c.destroy();
                return;
            }

            if (category) {
                c.visible = c.type.includes(category) || c.type === 'app' && c.category.includes(category);
            } else {
                c.visible = buttons.includes(c);
            }
        });

        // reset temporary button storage
        this._transientButtons = [];
        this._searchProviderButtons = [];

        if (autoCompletes) {
            Util.each(autoCompletes, item => {
                let button = new TransientButton(this, item);
                this._transientButtons.push(button);
                this.applicationsBox.add_actor(button);
            });
        }
    }

    _setCategoriesButtonActive(active) {
        try {
            let categoriesButtons = this.categoriesBox.get_children();
            for (var i in categoriesButtons) {
                let button = categoriesButtons[i];
                let icon = button.icon;
                if (active){
                    button.set_style_class_name("menu-category-button");
                    if (icon) {
                        icon.set_opacity(255);
                    }
                } else {
                    button.set_style_class_name("menu-category-button-greyed");
                    if (icon) {
                        let icon_opacity = icon.get_theme_node().get_double('opacity');
                        icon_opacity = Math.min(Math.max(0, icon_opacity), 1);
                        if (icon_opacity) // Don't set opacity to 0 if not defined
                            icon.set_opacity(icon_opacity * 255);
                    }
                }
            }
        } catch (e) {
            global.log(e);
        }
    }

    resetSearch(){
        this.searchEntry.set_text("");
    }

    _onSearchTextChanged() {
        let searchString = this.searchEntry.get_text().trim();
        let searchActive = !(searchString == '' || searchString == this.searchEntry.hint_text);
        if (!this.searchActive && !searchActive)
            return;

        if (searchString == this._previousSearchPattern)
            return;
        this._previousSearchPattern = searchString;

        this.searchActive = searchActive;
        this._fileFolderAccessActive = searchActive && this.searchFilesystem;
        this._clearAllSelections();

        if (searchActive) {
            this.searchEntry.set_secondary_icon(this._searchActiveIcon);
            if (!this._searchIconClickedId) {
                this._searchIconClickedId =
                    this.searchEntry.connect('secondary-icon-clicked', () => {
                        this.resetSearch();
                        this._select_category();
                    });
            }
            this._setCategoriesButtonActive(false);
            this.lastSelectedCategory = "search"

            this._doSearch(searchString);
        } else {
            if (this._searchIconClickedId > 0)
                this.searchEntry.disconnect(this._searchIconClickedId);
            this._searchIconClickedId = 0;
            this.searchEntry.set_secondary_icon(this._searchInactiveIcon);
            this._previousSearchPattern = "";
            this._setCategoriesButtonActive(true);
            this._select_category();
            this._allAppsCategoryButton.style_class = "menu-category-button-selected";
            this._activeContainer = null;
            this.selectedAppTitle.set_text("");
            this.selectedAppDescription.set_text("");
        }
    }

    _matchNames(buttons, pattern){
        let res = [];
        let exactMatch = null;
        for (let i = 0; i < buttons.length; i++) {
            let name = buttons[i].name;
            let lowerName = name.toLowerCase();
            if (lowerName.includes(pattern))
                res.push(buttons[i]);
            if (!exactMatch && lowerName === pattern)
                exactMatch = buttons[i];
        }
        return [res, exactMatch];
    }

    _listApplications(pattern){
        if (!pattern)
            return [[], null];

        let res = [];
        let exactMatch = null;
        let regexpPattern = new RegExp("\\b"+pattern);

        for (let i in this._applicationsButtons) {
            let app = this._applicationsButtons[i].app;
            let latinisedLowerName = Util.latinise(app.get_name().toLowerCase());
            if (latinisedLowerName.match(regexpPattern) !== null) {
                res.push(this._applicationsButtons[i]);
                if (!exactMatch && latinisedLowerName === pattern)
                    exactMatch = this._applicationsButtons[i];
            }
        }

        if (!exactMatch) {
            for (let i in this._applicationsButtons) {
                let app = this._applicationsButtons[i].app;
                if ((Util.latinise(app.get_name().toLowerCase()).split(' ').some(word => word.startsWith(pattern))) || // match on app name
                    (app.get_keywords() && Util.latinise(app.get_keywords().toLowerCase()).split(';').some(keyword => keyword.startsWith(pattern))) || // match on keyword
                    (app.get_description() && Util.latinise(app.get_description().toLowerCase()).split(' ').some(word => word.startsWith(pattern))) || // match on description
                    (app.get_id() && Util.latinise(app.get_id().slice(0, -8).toLowerCase()).startsWith(pattern))) { // match on app ID
                    res.push(this._applicationsButtons[i]);
                }
            }
        }

        return [res, exactMatch];
    }

    _doSearch(rawPattern){
        let pattern = Util.latinise(rawPattern.toLowerCase());

        this._searchTimeoutId = 0;
        this._activeContainer = null;
        this._activeActor = null;
        this._selectedItemIndex = null;
        this._previousTreeSelectedActor = null;
        this._previousSelectedActor = null;

        let [buttons, exactMatch] = this._listApplications(pattern);

        let result = this._matchNames(this._placesButtons, pattern);
        buttons = buttons.concat(result[0]);
        exactMatch = exactMatch || result[1];

        result = this._matchNames(this._recentButtons, pattern);
        buttons = buttons.concat(result[0]);
        exactMatch = exactMatch || result[1];

        var acResults = []; // search box autocompletion results
        if (this.searchFilesystem) {
            // Don't use the pattern here, as filesystem is case sensitive
            acResults = this._getCompletions(rawPattern);
        }

        this._displayButtons(null, buttons, acResults);

        if (buttons.length || acResults.length) {
            this.applicationsBox.reloadVisible();
            let item_actor = exactMatch ? exactMatch : this.applicationsBox.getFirstVisible();
            this._selectedItemIndex = this.applicationsBox.getAbsoluteIndexOfChild(item_actor);
            this._activeContainer = this.applicationsBox;
            this._scrollToButton(item_actor);
            this._buttonEnterEvent(item_actor);
        } else {
            this.selectedAppTitle.set_text("");
            this.selectedAppDescription.set_text("");
        }

        SearchProviderManager.launch_all(pattern, (provider, results) => {
            try {
                for (var i in results) {
                    if (results[i].type != 'software')
                    {
                        let button = new SearchProviderResultButton(this, provider, results[i]);
                        this._searchProviderButtons.push(button);
                        this.applicationsBox.add_actor(button);
                        if (this._selectedItemIndex === null) {
                            this.applicationsBox.reloadVisible();
                            let item_actor = this.applicationsBox.getFirstVisible();
                            this._selectedItemIndex = this.applicationsBox.getAbsoluteIndexOfChild(item_actor);
                            this._activeContainer = this.applicationsBox;
                            if (item_actor && item_actor != this.searchEntry) {
                                this._buttonEnterEvent(item_actor);
                            }
                        }
                    }
                }
            } catch(e) {
                global.log(e);
            }
        });

        return false;
    }

    _getCompletion (text) {
        if (!text.includes('/') || text.endsWith('/'))
            return '';
        return this._pathCompleter.get_completion_suffix(text);
    }

    _getCompletions (text) {
        if (!text.includes('/'))
            return [];
        return this._pathCompleter.get_completions(text);
    }
};

function main(metadata, orientation, panel_height, instance_id) {
    return new CinnamonMenuApplet(orientation, panel_height, instance_id);
}
