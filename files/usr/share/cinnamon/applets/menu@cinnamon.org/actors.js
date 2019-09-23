const Atk = imports.gi.Atk;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const St = imports.gi.St;

const AppFavorites = imports.ui.appFavorites;
const DND = imports.ui.dnd;
const PopupMenu = imports.ui.popupMenu;
const Params = imports.misc.params;
const Util = imports.misc.util;

const { USER_DESKTOP_PATH,
        APPLICATION_ICON_SIZE,
        CATEGORY_ICON_SIZE,
        CONTEXT_MENU_ICON_SIZE,
        MAX_BUTTON_WIDTH,
        CAN_UNINSTALL_APPS,
        HAVE_OPTIRUN } = require('./constants');

const { getFavIconSize,
        launchFile,
        addLauncherToPanel,
        copyLauncherToDesktop } = require('./utils');

const appFavs = AppFavorites.getAppFavorites();

/**
 * SimpleMenuItem type strings in use:
 * -------------------------------------------------
 * app              ApplicationButton
 * category         CategoryButton
 * fav              FavoritesButton
 * no-recent        "No recent documents" button
 * none             Default type
 * place            PlaceButton
 * recent           RecentsButton
 * recent-clear     "Clear recent documents" button
 * search-provider  SearchProviderResultButton
 * system           SystemButton
 * transient        TransientButton
 */

/**
 * SimpleMenuItem default parameters.
 */
const SMI_DEFAULT_PARAMS = Object.freeze({
    name:            '',
    description:     '',
    type:            'none',
    style:           MAX_BUTTON_WIDTH,
    styleClass:      'popup-menu-item',
    accessible_role: Atk.Role.MENU_ITEM,
    reactive:        true,
    activatable:     true,
    withMenu:        false
});

/**
 * A simpler alternative to PopupBaseMenuItem - does not implement all interfaces of PopupBaseMenuItem. Any
 * additional properties in the params object beyond defaults will also be set on the instance.
 * @param {Object}   applet                 - The menu applet instance
 * @param {Object}   params                 - Object containing item parameters, all optional.
 * @param {string}   params.name            - The name for the menu item.
 * @param {string}   params.description     - The description for the menu item.
 * @param {string}   params.type            - A string describing the type of item.
 * @param {string}   params.style           - Inline CSS, separated by ';'
 * @param {string}   params.styleClass      - The item's CSS style class.
 * @param {Atk.Role} params.accessible_role - The item's Accessibility Toolkit role.
 * @param {boolean}  params.reactive        - Item recieves events.
 * @param {boolean}  params.activatable     - Activates via primary click. Must provide an 'activate' function on
 *                                            the prototype or instance.
 * @param {boolean}  params.withMenu        - Shows menu via secondary click. Must provide a 'populateMenu' function
 *                                            on the prototype or instance.
 */
var SimpleMenuItem = GObject.registerClass(
class SimpleMenuItem extends St.BoxLayout {
    _init(applet, params) {
        params = Params.parse(params, SMI_DEFAULT_PARAMS, true);
        super._init({ style_class: params.styleClass });

        this.applet = applet;
        this.label = null;
        this.icon = null;

        for (let prop in params)
            this[prop] = params[prop];
    }

    // FIXME: backwards compatibility with split object/actor
    get actor() { log('using actor on SMI'); global.logTrace(); return this }
    get _delegate() { log('using _delegate on SMI'); global.logTrace(); return this }

    get children() { return this.get_children() }

    vfunc_enter_event(event) {
        if (!this.reactive)
            return Clutter.EVENT_PROPAGATE;

        this.applet._buttonEnterEvent(this);
        return Clutter.EVENT_STOP;
    }

    vfunc_leave_event(event) {
        if (!this.reactive)
            return Clutter.EVENT_PROPAGATE;

        this.applet._buttonLeaveEvent(this);
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        let b = event.button;
        if (this.activate && b === Clutter.BUTTON_PRIMARY) {
            this.activate();
            return Clutter.EVENT_STOP;
        } else if (this.populateMenu && b === Clutter.BUTTON_SECONDARY) {
            this.applet.toggleContextMenu(this);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_key_press_event(event) {
        let kv = event.keyval;
        if (this.activate &&
            (kv === Clutter.KEY_space ||
             kv === Clutter.KEY_Return ||
             kv === Clutter.KP_Enter)) {
            this.activate();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * Adds an StIcon as the next child, acessible as `this.icon`.
     *
     * Either an icon name or gicon is required. Only one icon is supported by the
     * base SimpleMenuItem.
     *
     * @param {number}  iconSize - The icon size in px.
     * @param {string}  iconName - (optional) The icon name string.
     * @param {object}  gicon    - (optional) A gicon.
     * @param {boolean} symbolic - (optional) Whether the icon should be symbolic. Default: false.
     */
    addIcon(iconSize, iconName='', gicon=null, symbolic=false) {
        if (this.icon)
            return;

        let params = { icon_size: iconSize };

        if (iconName)
            params.icon_name = iconName;
        else if (gicon)
            params.gicon = gicon;

        params.icon_type = symbolic ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;

        this.icon = new St.Icon(params);
        this.add_actor(this.icon);
    }

    /**
     * Removes the icon previously added with addIcon()
     */
    removeIcon() {
        if (!this.icon)
            return;
        this.icon.destroy();
        this.icon = null;
    }

    /**
     * Adds an StLabel as the next child, accessible as `this.label`.
     *
     * Only one label is supported by the base SimpleMenuItem prototype.
     *
     * @param {string} label      - (optional) An unformatted string. If markup is required, use
     *                               native methods directly: `this.label.clutter_text.set_markup()`.
     * @param {string} styleClass - (optional) A style class for the label.
     */
    addLabel(label='', styleClass=null) {
        if (this.label)
            return;

        this.label = new St.Label({ text: label, y_expand: true, y_align: Clutter.ActorAlign.CENTER });
        if (styleClass)
            this.label.set_style_class_name(styleClass);
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_actor(this.label);
    }

    /**
     * Removes the label previously added with addLabel()
     */
    removeLabel() {
        if (!this.label)
            return;
        this.label.destroy();
        this.label = null;
    }

    destroy() {
        if (this.label)
            this.label.destroy();
        if (this.icon)
            this.icon.destroy();

        delete this.label;
        delete this.icon;

        super.destroy();
    }
});

// GenericApplicationButton context menu items.
// each object in the array is an array containing:
// [display title, icon name, activate function, visible function or boolean]
const AppContextMenuInfos = Object.freeze([
    [ _("Add to panel"), "list-add", addLauncherToPanel, true ],
    [ _("Add to desktop"), "computer", copyLauncherToDesktop, USER_DESKTOP_PATH != null ],
    [ _("Remove from favorites"), "starred", appFavs.removeFavorite, appFavs.isFavorite ],
    [ _("Add to favorites"), "non-starred", appFavs.addFavorite, (id) => !appFavs.isFavorite(id) ],
    [ _("Uninstall"), "edit-delete", (id, path) => Util.spawnCommandLine(`/usr/bin/cinnamon-remove-application '${path}'`), CAN_UNINSTALL_APPS ],
    [ _("Run with NVIDIA GPU"), "cpu", (id) => { Util.spawnCommandLine(`optirun gtk-launch ${id}`) }, HAVE_OPTIRUN ]
]);

var GenericApplicationButton = GObject.registerClass(
class GenericApplicationButton extends SimpleMenuItem {
    _init(applet, app, type, withMenu=false, styleClass="") {
        let desc = app.get_description() || "";
        super._init(applet, { name: app.get_name(),
                              description: desc.split("\n")[0],
                              type: type,
                              withMenu: withMenu,
                              styleClass: styleClass,
                              appId: app.get_id(),
                              appPath: app.get_app_info().get_filename(),
                              app: app });
    }

    highlight() {
        if (this.has_style_pseudo_class('highlighted'))
            return;

        this.add_style_pseudo_class('highlighted');
    }

    unhighlight() {
        if (!this.has_style_pseudo_class('highlighted'))
            return;

        let appKey = this.appId || `${this.name}:${this.description}`;
        this.applet._knownApps.add(appKey);
        this.remove_style_pseudo_class('highlighted');
    }

    activate() {
        this.unhighlight();
        this.app.open_new_window(-1);
        this.applet.menu.close();
    }

    populateMenu(menu) {
        let menuItem;
        for (let info of AppContextMenuInfos) {
            if (!info[3] || (typeof info[3] === 'function' &&
                             info[3](this.appId, this.appPath) != true)) {
                continue;
            }

            menuItem = new SimpleMenuItem(this.applet, { type: 'context-menu-item' });

            menuItem.activate = () => {
                info[2](this.appId, this.appPath);
                this.applet.toggleContextMenu(this);
                this.applet.menu.close();
            }

            menuItem.addIcon(CONTEXT_MENU_ICON_SIZE, info[1], null, true);
            menuItem.addLabel(info[0]);

            menu.addMenuItem(menuItem);
        }
    }
});

var ApplicationButton = GObject.registerClass(
class ApplicationButton extends GenericApplicationButton {
    _init(applet, app) {
        super._init(applet, app, 'app', true, 'menu-application-button');
        this.category = [];

        this.icon = this.app.create_icon_texture(APPLICATION_ICON_SIZE);
        this.add_actor(this.icon);
        if (!applet.showApplicationIcons)
            this.icon.visible = false;

        this.addLabel(this.name, 'menu-application-button-label');

        this._draggable = DND.makeDraggable(this);
        this._dragEndId = this._draggable.connect('drag-end', (...args) => this._onDragEnd(...args));
        this.isDraggableApp = true;
    }

    get_app_id() {
        return this.app.get_id();
    }

    getDragActor() {
        return this.app.create_icon_texture(getFavIconSize());
    }

    // Returns the original actor that should align with the actor
    // we show as the item is being dragged.
    getDragActorSource() {
        return this;
    }

    _onDragEnd() {
        this.applet.favoritesBox._clearDragPlaceholder();
    }

    destroy() {
        this._draggable.disconnect(this._dragEndId);
        super.destroy();
    }
});

var FavoritesButton = GObject.registerClass(
class FavoritesButton extends GenericApplicationButton {
    _init(applet, app) {
        super._init(applet, app, 'fav', false, 'menu-favorites-button');
        this.icon = app.create_icon_texture(getFavIconSize());
        this.add_actor(this.icon);

        this._draggable = DND.makeDraggable(this);
        this._dragEndId = this._draggable.connect('drag-end', (...args) => this._onDragEnd(...args));
        this.isDraggableApp = true;
    }

    _onDragEnd() {
        this.get_parent()._clearDragPlaceholder();
    }

    get_app_id() {
        return this.app.get_id();
    }

    getDragActor() {
        return new Clutter.Clone({ source: this });
    }

    // Returns the original actor that should align with the actor
    // we show as the item is being dragged.
    getDragActorSource() {
        return this;
    }

    destroy() {
        this._draggable.disconnect(this._dragEndId);
        super.destroy();
    }
});

var TransientButton = GObject.registerClass(
class TransientButton extends SimpleMenuItem {
    _init(applet, pathOrCommand) {
        super._init(applet, { description: pathOrCommand,
                              type: 'transient',
                              styleClass: 'menu-application-button' });

        if (pathOrCommand.startsWith('~')) {
            pathOrCommand = pathOrCommand.slice(1);
            pathOrCommand = GLib.get_home_dir() + pathOrCommand;
        }

        this.isPath = pathOrCommand.substr(pathOrCommand.length - 1) == '/';
        if (this.isPath) {
            this.path = pathOrCommand;
        } else {
            let n = pathOrCommand.lastIndexOf('/');
            if (n != 1) {
                this.path = pathOrCommand.substr(0, n);
            }
        }

        this.pathOrCommand = pathOrCommand;

        this.file = Gio.file_new_for_path(this.pathOrCommand);

        if (applet.showApplicationIcons) {
            try {
                this.handler = this.file.query_default_handler(null);
                let contentType = Gio.content_type_guess(this.pathOrCommand, null);
                let themedIcon = Gio.content_type_get_icon(contentType[0]);
                this.icon = new St.Icon({gicon: themedIcon, icon_size: APPLICATION_ICON_SIZE, icon_type: St.IconType.FULLCOLOR });
            } catch (e) {
                this.handler = null;
                let iconName = this.isPath ? 'folder' : 'unknown';
                this.icon = new St.Icon({icon_name: iconName, icon_size: APPLICATION_ICON_SIZE, icon_type: St.IconType.FULLCOLOR});
                // @todo Would be nice to indicate we don't have a handler for this file.
            }

            this.add_actor(this.icon);
        }

        this.addLabel(this.description, 'menu-application-button-label');

        this.isDraggableApp = false;
    }

    activate() {
        if (this.handler != null) {
            this.handler.launch([this.file], null);
        } else {
            // Try anyway, even though we probably shouldn't.
            try {
                Util.spawn(['gvfs-open', this.file.get_uri()]);
            } catch (e) {
                global.logError("No handler available to open " + this.file.get_uri());
            }
        }

        this.applet.menu.close();
    }
});

var SearchProviderResultButton = GObject.registerClass(
class SearchProviderResultButton extends SimpleMenuItem {
    _init(applet, provider, result) {
        super._init(applet, { name: result.label,
                              description: result.description,
                              type: 'search-provider',
                              styleClass: 'menu-application-button',
                              provider: provider,
                              result: result });

        if (applet.showApplicationIcons) {
            if (result.icon) {
                this.icon = result.icon;
            } else if (result.icon_app) {
                this.icon = result.icon_app.create_icon_texture(APPLICATION_ICON_SIZE);
            } else if (result.icon_filename) {
                this.icon = new St.Icon({ gicon: new Gio.FileIcon({file: Gio.file_new_for_path(result.icon_filename)}),
                                          icon_size: APPLICATION_ICON_SIZE });
            }

            if (this.icon)
                this.add_actor(this.icon);
        }

        this.addLabel(result.label, 'menu-application-button-label');
    }

    activate() {
        try {
            this.provider.on_result_selected(this.result);
            this.applet.menu.close();
        } catch(e) {
            global.logError(e);
        }
    }

    destroy() {
        delete this.provider;
        delete this.result;
        super.destroy();
    }
});

var PlaceButton = GObject.registerClass(
class PlaceButton extends SimpleMenuItem {
    _init(applet, place) {
        let selectedAppId = place.idDecoded.substr(place.idDecoded.indexOf(':') + 1);
        let fileIndex = selectedAppId.indexOf('file:///');
        if (fileIndex !== -1)
            selectedAppId = selectedAppId.substr(fileIndex + 7);

        super._init(applet, { name: place.name,
                              description: selectedAppId,
                              type: 'place',
                              styleClass: 'menu-application-button',
                              place: place });

        this.icon = place.iconFactory(APPLICATION_ICON_SIZE);
        if (this.icon)
            this.add_actor(this.icon);
        else
            this.addIcon(APPLICATION_ICON_SIZE, 'folder');

        if (!applet.showApplicationIcons)
            this.icon.visible = false;

        this.addLabel(this.name, 'menu-application-button-label');
    }

    activate() {
        this.place.launch();
        this.applet.menu.close();
    }
});

var RecentButton = GObject.registerClass(
class RecentButton extends SimpleMenuItem {
    _init(applet, recent) {
        let fileIndex = recent.uriDecoded.indexOf("file:///");
        let selectedAppUri = fileIndex === -1 ? "" : recent.uriDecoded.substr(fileIndex + 7);

        super._init(applet, { name: recent.name,
                              description: selectedAppUri,
                              type: 'recent',
                              styleClass: 'menu-application-button',
                              withMenu: true,
                              mimeType: recent.mimeType,
                              uri: recent.uri,
                              uriDecoded: recent.uriDecoded });

        this.icon = recent.createIcon(APPLICATION_ICON_SIZE);
        this.add_actor(this.icon);
        if (!applet.showApplicationIcons)
            this.icon.visible = false;

        this.addLabel(this.name, 'menu-application-button-label');
    }

    activate() {
        launchFile(this.uri);
        this.applet.menu.close();
    }

    hasLocalPath(file) {
        return file.is_native() || file.get_path() != null;
    }

    populateMenu(menu) {
        let menuItem;
        menuItem = new PopupMenu.PopupMenuItem(_("Open with"), { reactive: false });
        menuItem.actor.style = "font-weight: bold";
        menu.addMenuItem(menuItem);

        let file = Gio.File.new_for_uri(this.uri);

        let default_info = Gio.AppInfo.get_default_for_type(this.mimeType, !this.hasLocalPath(file));

        let infoLaunchFunc = (info, file) => {
            info.launch([file], null);
            this.applet.toggleContextMenu(this);
            this.applet.menu.close();
        };

        if (default_info) {
            menuItem = new SimpleMenuItem(this.applet, { focusOnHover: false });
            menuItem.addLabel(default_info.get_display_name());
            menuItem.activate = () => infoLaunchFunc(default_info, file);
            menu.addMenuItem(menuItem);
        }

        let infos = Gio.AppInfo.get_all_for_type(this.mimeType);

        for (let i = 0; i < infos.length; i++) {
            let info = infos[i];

            file = Gio.File.new_for_uri(this.uri);

            if (info.equal(default_info) || (!this.hasLocalPath(file) && !info.supports_uris()))
                continue;

            menuItem = new SimpleMenuItem(this, { focusOnHover: false });
            menuItem.activate = () => infoLaunchFunc(info, file);
            menu.addMenuItem(menuItem);
        }

        if (GLib.find_program_in_path ("nemo-open-with") != null) {
            menuItem = new SimpleMenuItem(this, { focusOnHover: false });
            menuItem.addLabel(_("Other application..."));
            menuItem.activate = () => {
                Util.spawnCommandLine("nemo-open-with " + this.uri);
                this.applet.toggleContextMenu(this);
                this.applet.menu.close();
            };
            menu.addMenuItem(menuItem);
        }
    }
});

var CategoryButton = GObject.registerClass(
class CategoryButton extends SimpleMenuItem {
    _init(applet, categoryId, label, icon) {
        super._init(applet, { name: label || _("All Applications"),
                              type: 'category',
                              styleClass: 'menu-category-button',
                              categoryId: categoryId });

        if (typeof icon === 'string')
            this.addIcon(CATEGORY_ICON_SIZE, icon);
        else if (icon)
            this.addIcon(CATEGORY_ICON_SIZE, null, icon);

        if (this.icon && !applet.showCategoryIcons)
            this.icon.visible = false;

        this.addLabel(this.name, 'menu-category-button-label');
    }
});

var SystemButton = GObject.registerClass(
class SystemButton extends SimpleMenuItem {
    _init(applet, iconName, name, desc) {
        super._init(applet, { name: name,
                              description: desc,
                              type: 'system',
                              styleClass: 'menu-favorites-button' });
        this.addIcon(getFavIconSize(), iconName);
    }
});

var SimpleMenuBox = GObject.registerClass(
class SimpleMenuBox extends St.BoxLayout {
    _init(params) {
        super._init(params);
        this.array = [];
    }

    get actor() {
        return this;
    }

    get _delegate() {
        return this;
    }

    reloadVisible() {
        this.array = this.get_focus_chain().filter(x => x instanceof SimpleMenuItem);
    }

    getNextVisible(curChild) {
        return this.getVisibleItem(this.array.indexOf(curChild) + 1);
    }

    getPrevVisible(curChild) {
        return this.getVisibleItem(this.array.indexOf(curChild) - 1);
    }

    getFirstVisible() {
        return this.array[0];
    }

    getLastVisible() {
        return this.array[this.array.length - 1];
    }

    getVisibleIndex(curChild) {
        return this.array.indexOf(curChild);
    }

    getVisibleItem(index) {
        let len = this.array.length;
        index = ((index % len) + len) % len;
        return this.array[index];
    }

    getNumVisibleChildren() {
        return this.array.length;
    }

    getAbsoluteIndexOfChild(child) {
        return this.get_children().indexOf(child);
    }
});

var CategoriesBox = GObject.registerClass(
class CategoriesBox extends SimpleMenuBox {
    _init() {
        super._init({ style_class: 'menu-categories-box',
                      vertical: true,
                      accessible_role: Atk.Role.LIST });
        this.trackerId = 0;
        this.inhibitedChildren = [];
    }

    startInhibit() {
        if (this.trackerId || this.inhibitedChildren.length)
            return;

        let [lastX, lastY, ] = global.get_pointer();
        let didInhibit = false;

        this.trackerId = GLib.timeout_add(GLib.PRIORITY_LOW, 100, () => {
            let [x, y, ] = global.get_pointer();
            let dx = x - lastX;
            if (dx < 0 || dx < Math.abs(y - lastY) / 2) {
                log(`dx:${dx} dy:${Math.abs(y - lastY)}`)
                this.stopInhibit();
                return false;
            }
            if (!didInhibit) {
                this.get_children().forEach(c => {
                    if (!c.reactive)
                        return;
                    c.reactive = false;
                    this.inhibitedChildren.push(c);
                });
                didInhibit = true;
            }
            [lastX, lastY] = [x, y];
            return true;
        });
    }

    stopInhibit() {
        if (this.trackerId) {
            GLib.source_remove(this.trackerId);
            this.trackerId = 0;
        }
        let children = this.get_children();
        this.inhibitedChildren.forEach(c => {
            if (children.includes(c))
                c.reactive = true;
        });
        this.inhibitedChildren = [];
    }
});

var FavoritesBox = GObject.registerClass(
class FavoritesBox extends SimpleMenuBox {
    _init() {
        super._init({ vertical: true });

        this._dragPlaceholder = null;
        this._dragPlaceholderPos = -1;
        this._animatingPlaceholdersCount = 0;
    }

    _clearDragPlaceholder() {
        if (this._dragPlaceholder) {
            this._dragPlaceholder.animateOutAndDestroy();
            this._dragPlaceholder = null;
            this._dragPlaceholderPos = -1;
        }
    }

    handleDragOver (source, actor, x, y, time) {
        let app = source.app;

        let favorites = appFavs.getFavorites();
        let numFavorites = favorites.length;

        let favPos = favorites.indexOf(app);

        let children = this.get_children();
        let numChildren = children.length;
        let boxHeight = this.height;

        // Keep the placeholder out of the index calculation; assuming that
        // the remove target has the same size as "normal" items, we don't
        // need to do the same adjustment there.
        if (this._dragPlaceholder) {
            boxHeight -= this._dragPlaceholder.actor.height;
            numChildren--;
        }

        let pos = Math.round(y * numChildren / boxHeight);

        if (pos != this._dragPlaceholderPos && pos <= numFavorites) {
            if (this._animatingPlaceholdersCount > 0) {
                let appChildren = children.filter(function(actor) {
                    return (actor instanceof FavoritesButton);
                });
                this._dragPlaceholderPos = children.indexOf(appChildren[pos]);
            } else {
                this._dragPlaceholderPos = pos;
            }

            // Don't allow positioning before or after self
            if (favPos != -1 && (pos == favPos || pos == favPos + 1)) {
                if (this._dragPlaceholder) {
                    this._dragPlaceholder.animateOutAndDestroy();
                    this._animatingPlaceholdersCount++;
                    this._dragPlaceholder.actor.connect('destroy', () => { this._animatingPlaceholdersCount-- });
                }
                this._dragPlaceholder = null;

                return DND.DragMotionResult.CONTINUE;
            }

            // If the placeholder already exists, we just move
            // it, but if we are adding it, expand its size in
            // an animation
            let fadeIn;
            if (this._dragPlaceholder) {
                this._dragPlaceholder.actor.destroy();
                fadeIn = false;
            } else {
                fadeIn = true;
            }

            this._dragPlaceholder = new DND.GenericDragPlaceholderItem();
            this._dragPlaceholder.child.set_width (source.actor.height);
            this._dragPlaceholder.child.set_height (source.actor.height);
            this.insert_child_at_index(this._dragPlaceholder.actor,
                                       this._dragPlaceholderPos);
            if (fadeIn)
                this._dragPlaceholder.animateIn();
        }

        let id = app.get_id();
        let favoritesMap = appFavs.getFavoriteMap();
        let srcIsFavorite = (id in favoritesMap);

        if (!srcIsFavorite)
            return DND.DragMotionResult.COPY_DROP;

        return DND.DragMotionResult.MOVE_DROP;
    }

    // Draggable target interface
    acceptDrop (source, actor, x, y, time) {
        let app = source.app;

        let id = app.get_id();

        let favorites = appFavs.getFavoriteMap();

        let srcIsFavorite = (id in favorites);

        let favPos = 0;
        let children = this.get_children();
        for (let i = 0; i < this._dragPlaceholderPos; i++) {
            if (this._dragPlaceholder &&
                children[i] == this._dragPlaceholder.actor)
                continue;

            if (!(children[i] instanceof FavoritesButton)) continue;

            let childId = children[i].app.get_id();
            if (childId == id)
                continue;
            if (childId in favorites)
                favPos++;
        }

        Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            let appFavorites = appFavs;
            if (srcIsFavorite)
                appFavorites.moveFavoriteToPos(id, favPos);
            else
                appFavorites.addFavoriteAtPos(id, favPos);
            return false;
        });

        return true;
    }
});