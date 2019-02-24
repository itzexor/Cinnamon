// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * FILE:lookingGlass.js
 * @short_description: Cinnamon's inspector and js command line
 *
 * The user interface for lookingGlass.js is the python program Melange.
 * This file implements the actual inspection code and exposes it over dbus
 * for Melange.
 *
 * Since we have to export js value representations over dbus, and have to avoid
 * special js types, we have a custom type system in use in addition to the standard
 * js type names:
 *  - 'array': should only show enumerable properties
 *  - 'prototype': prototypes for gobject and gboxed - not inspectable
 *  - 'importer': file importers - not inspectable
 *  - GTypes - inspected via GIRepository
 */

const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const Cogl = imports.gi.Cogl;
const Gio = imports.gi.Gio;
const Gir = imports.gi.GIRepository;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Signals = imports.signals;
const St = imports.gi.St;
const System = imports.system;

const Extension = imports.ui.extension;
const History = imports.misc.history;
const Main = imports.ui.main;

const HISTORY_KEY = 'looking-glass-history';

// dbus interfaces
const MELANGE_IFACE =
    '<node> \
        <interface name="org.Cinnamon.Melange"> \
            <method name="toggle" /> \
        </interface> \
     </node>';

const LG_IFACE =
    '<node> \
        <interface name="org.Cinnamon.LookingGlass"> \
            <method name="Eval"> \
                <arg type="s" direction="in" name="code"/> \
            </method> \
            <method name="GetResults"> \
                <arg type="b" direction="out" name="success"/> \
                <arg type="aa{ss}" direction="out" name="array of dictionary containing keys: command, type, object, index"/> \
            </method> \
            <method name="AddResult"> \
                <arg type="s" direction="in" name="code"/> \
            </method> \
            <method name="GetErrorStack"> \
                <arg type="b" direction="out" name="success"/> \
                <arg type="aa{ss}" direction="out" name="array of dictionary containing keys: timestamp, category, message"/> \
            </method> \
            <method name="FullGc"> \
            </method> \
            <method name="Inspect"> \
                <arg type="s" direction="in" name="code"/> \
                <arg type="b" direction="out" name="success"/> \
                <arg type="aa{ss}" direction="out" name="array of dictionary containing keys: name, type, value, shortValue"/> \
            </method> \
            <method name="GetLatestWindowList"> \
                <arg type="b" direction="out" name="success"/> \
                <arg type="aa{ss}" direction="out" name="array of dictionary containing keys: id, title, wmclass, app"/> \
            </method> \
            <method name="StartInspector"> \
            </method> \
            <method name="GetExtensionList"> \
                <arg type="b" direction="out" name="success"/> \
                <arg type="aa{ss}" direction="out" name="array of dictionary containing keys: status, name, description, uuid, folder, url, type"/> \
            </method> \
            <method name="ReloadExtension"> \
                <arg type="s" direction="in" name="uuid"/> \
                <arg type="s" direction="in" name="type"/> \
            </method> \
            <signal name="LogUpdate"></signal> \
            <signal name="WindowListUpdate"></signal> \
            <signal name="ResultUpdate"></signal> \
            <signal name="InspectorDone"></signal> \
            <signal name="ExtensionListUpdate"></signal> \
        </interface> \
    </node>';

// prepended to any user js for convenience
const COMMAND_HEADER =
`const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;

const LookingGlass = imports.ui.lookingGlass;
const Main = imports.ui.main;
const Tweener = imports.ui.tweener;

const it = LookingGlass.it;
const a = LookingGlass.getWindowApp;
const r = LookingGlass.getResult;
const w = LookingGlass.getWindow;`;

// primitive js types and certain objects to avoid inspecting
// keep in sync with page_inspect.py
const NON_INSPECTABLE_TYPES = [
    'boolean',
    'function',
    'importer',
    'null',
    'number',
    'prototype',
    'string',
    'symbol',
    'undefined'
];

// matches gi object toString values
const GI_RE = /^\[(?:boxed|object) (instance|prototype) (?:proxy|of) (?:GType|GIName):[\w.]+ [^\r\n]+\]$/;
// matches known importer toString values
const IMPORT_RE = /^\[(?:GjsFileImporter \w+|object GjsModule gi)\]$/;
const DASH_RE = /-/g;

/*************************************************
 * window list that's exposed over dbus          *
 *************************************************/
class WindowList {
    constructor(onUpdatedCallback) {
        this.lastId = 0;
        this.latestWindowList = [];
        this.onUpdated = onUpdatedCallback;

        let tracker = Cinnamon.WindowTracker.get_default();
        global.display.connect('window-created', Lang.bind(this, this._updateWindowList));
        tracker.connect('tracked-windows-changed', Lang.bind(this, this._updateWindowList));
    }

    getWindowById(id) {
        let windows = global.get_window_actors();
        for (let i = 0; i < windows.length; i++) {
            let metaWindow = windows[i].metaWindow;
            if (metaWindow._lgId === id)
                return metaWindow;
        }
        return null;
    }

    _updateWindowList() {
        let windows = global.get_window_actors();
        let tracker = Cinnamon.WindowTracker.get_default();

        let oldWindowList = this.latestWindowList;
        this.latestWindowList = [];
        for (let i = 0; i < windows.length; i++) {
            let metaWindow = windows[i].metaWindow;

            // only track "interesting" windows
            if (!Main.isInteresting(metaWindow))
                continue;

            // Avoid multiple connections
            if (!metaWindow._lookingGlassManaged) {
                metaWindow.connect('unmanaged', Lang.bind(this, this._updateWindowList));
                metaWindow._lookingGlassManaged = true;

                metaWindow._lgId = this.lastId;
                this.lastId++;
            }

            let lgInfo = {
                id: metaWindow._lgId.toString(),
                title: metaWindow.title + '',
                wmclass: metaWindow.get_wm_class() + '',
                app: '' };

            let app = tracker.get_window_app(metaWindow);
            if (app != null && !app.is_window_backed()) {
                lgInfo.app = app.get_id() + '';
            } else {
                lgInfo.app = '<untracked>';
            }

            this.latestWindowList.push(lgInfo);
        }

        // Make sure the list changed before notifying listeners
        let changed = oldWindowList.length != this.latestWindowList.length;
        if (!changed) {
            for (let i = 0; i < oldWindowList.length; i++) {
                if (oldWindowList[i].id != this.latestWindowList[i].id) {
                    changed = true;
                    break;
                }
            }
        }
        if (changed)
            this.onUpdated();
    }
};
Signals.addSignalMethods(WindowList.prototype);


/*************************************************
 * inspector for user actor picking              *
 *************************************************/
class Inspector {
    constructor() {
        let container = new Cinnamon.GenericContainer({ width: 0,
                                                     height: 0 });
        container.connect('allocate', Lang.bind(this, this._allocate));
        Main.uiGroup.add_actor(container);

        let eventHandler = new St.BoxLayout({ name: 'LookingGlassDialog',
                                              vertical: true,
                                              reactive: true });
        this._eventHandler = eventHandler;
        Main.pushModal(this._eventHandler);
        container.add_actor(eventHandler);
        this._displayText = new St.Label();
        eventHandler.add(this._displayText, { expand: true });
        this._passThroughText = new St.Label({style: 'text-align: center;'});
        eventHandler.add(this._passThroughText, { expand: true });

        this._borderPaintTarget = null;
        this._borderPaintId = null;
        eventHandler.connect('destroy', Lang.bind(this, this._onDestroy));
        this._capturedEventId = global.stage.connect('captured-event', Lang.bind(this, this._onCapturedEvent));

        // this._target is the actor currently shown by the inspector.
        // this._pointerTarget is the actor directly under the pointer.
        // Normally these are the same, but if you use the scroll wheel
        // to drill down, they'll diverge until you either scroll back
        // out, or move the pointer outside of _pointerTarget.
        this._target = null;
        this._pointerTarget = null;
        this.passThroughEvents = false;
        this._updatePassthroughText();
    }

    _addBorderPaintHook(actor) {
        let signalId = actor.connect_after('paint',
            function () {
                let color = new Cogl.Color();
                color.init_from_4ub(0xff, 0, 0, 0xc4);
                Cogl.set_source_color(color);

                let geom = actor.get_allocation_geometry();
                let width = 2;

                // clockwise order
                Cogl.rectangle(0, 0, geom.width, width);
                Cogl.rectangle(geom.width - width, width,
                               geom.width, geom.height);
                Cogl.rectangle(0, geom.height,
                               geom.width - width, geom.height - width);
                Cogl.rectangle(0, geom.height - width,
                               width, width);
            });

        actor.queue_redraw();
        return signalId;
    }

    _updatePassthroughText() {
        if (this.passThroughEvents)
            this._passThroughText.text = '(Press Pause or Control to disable event pass through)';
        else
            this._passThroughText.text = '(Press Pause or Control to enable event pass through)';
    }

    _onCapturedEvent(actor, event) {
        if (event.type() == Clutter.EventType.KEY_PRESS && (event.get_key_symbol() == Clutter.Control_L ||
                                                            event.get_key_symbol() == Clutter.Control_R ||
                                                            event.get_key_symbol() == Clutter.Pause)) {
            this.passThroughEvents = !this.passThroughEvents;
            this._updatePassthroughText();
            return true;
        }

        if (this.passThroughEvents)
            return false;

        switch (event.type()) {
            case Clutter.EventType.KEY_PRESS:
                return this._onKeyPressEvent(actor, event);
            case Clutter.EventType.BUTTON_PRESS:
                return this._onButtonPressEvent(actor, event);
            case Clutter.EventType.SCROLL:
                return this._onScrollEvent(actor, event);
            case Clutter.EventType.MOTION:
                return this._onMotionEvent(actor, event);
            default:
                return true;
        }
    }

    _allocate(actor, box, flags) {
        if (!this._eventHandler)
            return;

        let primary = Main.layoutManager.primaryMonitor;

        let [minWidth, minHeight, natWidth, natHeight] =
            this._eventHandler.get_preferred_size();

        let childBox = new Clutter.ActorBox();
        childBox.x1 = primary.x + Math.floor((primary.width - natWidth) / 2);
        childBox.x2 = childBox.x1 + natWidth;
        childBox.y1 = primary.y + Math.floor((primary.height - natHeight) / 2);
        childBox.y2 = childBox.y1 + natHeight;
        this._eventHandler.allocate(childBox, flags);
    }

    _close() {
        global.stage.disconnect(this._capturedEventId);
        Main.popModal(this._eventHandler);

        this._eventHandler.destroy();
        this._eventHandler = null;
        this.emit('closed');
    }

    _onDestroy() {
        if (this._borderPaintTarget != null)
            this._borderPaintTarget.disconnect(this._borderPaintId);
    }

    _onKeyPressEvent(actor, event) {
        if (event.get_key_symbol() == Clutter.Escape)
            this._close();
        return true;
    }

    _onButtonPressEvent(actor, event) {
        if (this._target) {
            let [stageX, stageY] = event.get_coords();
            this.emit('target', this._target, stageX, stageY);
        }
        this._close();
        return true;
    }

    _onScrollEvent(actor, event) {
        switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
                // select parent
                let parent = this._target.get_parent();
                if (parent != null) {
                    this._target = parent;
                    this._update(event);
                }
                break;

            case Clutter.ScrollDirection.DOWN:
                // select child
                if (this._target != this._pointerTarget) {
                    let child = this._pointerTarget;
                    while (child) {
                        let parent = child.get_parent();
                        if (parent == this._target)
                            break;
                        child = parent;
                    }
                    if (child) {
                        this._target = child;
                        this._update(event);
                    }
                }
                break;

            default:
                break;
        }
        return true;
    }

    _onMotionEvent(actor, event) {
        this._update(event);
        return true;
    }

    _update(event) {
        let [stageX, stageY] = event.get_coords();
        let target = global.stage.get_actor_at_pos(Clutter.PickMode.ALL,
                                                   stageX,
                                                   stageY);

        if (target != this._pointerTarget)
            this._target = target;
        this._pointerTarget = target;

        let position = '[inspect x: ' + stageX + ' y: ' + stageY + ']';
        this._displayText.text = '';
        this._displayText.text = position + ' ' + this._target;

        if (this._borderPaintTarget != this._target) {
            if (this._borderPaintTarget != null)
                this._borderPaintTarget.disconnect(this._borderPaintId);
            this._borderPaintTarget = this._target;
            this._borderPaintId = this._addBorderPaintHook(this._target);
        }
    }
}
Signals.addSignalMethods(Inspector.prototype);


/*************************************************
 * object/value inspection utility functions     *
 *************************************************/

// get list of keys for js objects
function _jsObjectGetKeys(obj, type) {
    let keys = new Set();
    let curProto = obj;

    // we ignore the Object prototype
    while (curProto && curProto !== Object.prototype) {
        let ownKeys;
        if (type === 'array') {
            // index properties only
            ownKeys = curProto.keys();
        } else {
            // all own properties and symbols
            ownKeys = Reflect.ownKeys(curProto);
        }

        // adding to set ignores duplicates
        for (let key of ownKeys)
            keys.add(key);

        curProto = Object.getPrototypeOf(curProto);
    }
    return Array.from(keys);
}

// get list of keys for introspected c types by gType name string
function _giGetKeys(obj, gTypeName) {
    if (gTypeName === 'GIRepositoryNamespace')
        return _giNamespaceGetKeys(obj)

    let gType = GObject.type_from_name(gTypeName);
    let info = Gir.Repository.get_default().find_by_gtype(gType);
    if (!info)
        return [];

    let type = info.get_type();
    switch (type) {
        case Gir.InfoType.STRUCT:
            return _giStructInfoGetKeys(info);
        case Gir.InfoType.OBJECT:
            return _giObjectInfoGetKeys(info);
        case Gir.InfoType.ENUM:
        case Gir.InfoType.FLAGS:
            return _giEnumInfoGetKeys(info);
        default:
            return [];
    }
}

// grab the "useful" key names for a GirNamespace
function _giNamespaceGetKeys(obj) {
    let repo = Gir.Repository.get_default();
    let keys = [];
    // the "__name__" property is set in ns.cpp in cjs
    let n = repo.get_n_infos(obj.__name__);
    for (let i = 0; i < n; i++) {
        let info = repo.get_info(obj.__name__, i);
        let name = info.get_name();
        switch (info.get_type()) {
            case Gir.InfoType.ENUM:
            case Gir.InfoType.FLAGS:
            case Gir.InfoType.FUNCTION:
            case Gir.InfoType.OBJECT:
                keys.push(name);
                break;
        }
    }
    return keys;
}

// grabs methods for a GIBaseInfo using the GIInfoType as a string:
// "enum", "object", "struct"
// skips any constructor or virtual functions
function _giInfoGetMethods(info, typeString) {
    let keys = [];
    let n = Gir[`${typeString}_info_get_n_methods`](info);
    for (let i = 0; i < n; i++) {
        let funcInfo = Gir[`${typeString}_info_get_method`](info, i);
        let flags = Gir.function_info_get_flags(funcInfo);

        if (!(flags & Gir.FunctionInfoFlags.WRAPS_VFUNC)
            && !(flags & Gir.FunctionInfoFlags.IS_CONSTRUCTOR))
            keys.push(funcInfo.get_name()
                              .replace(DASH_RE, '_'));
    }
    return keys;
}


// grab constants, readable properties, and methods of a GI_INFO_TYPE_OBJECT
// and its ancestors
// do we get duplicate keys here ever?
function _giObjectInfoGetKeys(info) {
    let keys = [];
    while(info) {
        // skip object/initially unowned typelibs
        let gType = Gir.registered_type_info_get_g_type(info);
        if (gType === GObject.Object.$gtype || gType === GObject.InitiallyUnowned.$gtype)
            break;

        let n = Gir.object_info_get_n_constants(info);
        for (let i = 0; i < n; i++)
            keys.push(Gir.object_info_get_constant(info, i)
                         .get_name()
                         .replace(DASH_RE, '_'));

        n = Gir.object_info_get_n_properties(info);
        for (let i = 0; i < n; i++) {
            let propInfo = Gir.object_info_get_property(info, i);
            let flags = Gir.property_info_get_flags(propInfo);
            if (flags & GObject.ParamFlags.READABLE)
                keys.push(propInfo.get_name()
                                  .replace(DASH_RE, '_'));
        }

        keys = keys.concat(_giInfoGetMethods(info, 'object'));

        info = Gir.object_info_get_parent(info);
    }
    return keys;
}

// grab fields and methods for a GI_INFO_TYPE_STRUCT
function _giStructInfoGetKeys(info) {
    let keys = [];
    let n = Gir.struct_info_get_n_fields(info);
    for (let i = 0; i < n; i++)
        keys.push(Gir.struct_info_get_field(info, i)
                     .get_name()
                     .replace(DASH_RE, '_'));

    return keys.concat(_giInfoGetMethods(info, 'struct'));
}

// grab values for a GI_INFO_TYPE_ENUM or GI_INFO_TYPE_FLAGS
// enum/flags object key names are always uppercase
function _giEnumInfoGetKeys(info) {
    let keys = [];
    let n = Gir.enum_info_get_n_values(info);
    for (let i = 0; i < n; i++)
        keys.push(Gir.enum_info_get_value(info, i)
                     .get_name()
                     .replace(DASH_RE, '_')
                     .toUpperCase());

    return keys.concat(_giInfoGetMethods(info, 'enum'));
}

/*************************************************
 * the actual looking glass implementation       *
 *************************************************/

let _initialized = false;
let _it = null;
let _settings = null;
let _results = [];
let _rawResults = [];
let _windowList = null;
let _history = null;
let _dbusImpl = null;
let _melangeProxy = null;

//dbus method handler/map
const _dbusHandlers = {
    AddResult: addResult,
    Eval: (command) => {
        _history.addItem(command);
        addResult(command);
    },
    FullGc: () => System.gc(),
    GetErrorStack: () => [true, Main._errorLogStack],
    GetExtensionList: getExtensionList,
    GetResults: () => [true, _rawResults],
    GetLatestWindowList:() => [true, getLatestWindowList()],
    Inspect: (path) => [true, inspect(path)],
    ReloadExtension: reloadExtension,
    StartInspector: () => startInspector(toggle)
};

// must be called by main.js during start()
function init() {
    if (_initialized)
        return;
    _initialized = true;

    _settings = new Gio.Settings({schema_id: "org.cinnamon.desktop.keybindings"});
    _settings.connect("changed::looking-glass-keybinding", _update_keybinding);
    _update_keybinding();

    _dbusImpl = Gio.DBusExportedObject.wrapJSObject(LG_IFACE, _dbusHandlers);
    _dbusImpl.export(Gio.DBus.session, '/org/Cinnamon/LookingGlass');
    Gio.DBus.session.own_name('org.Cinnamon.LookingGlass', Gio.BusNameOwnerFlags.REPLACE, null, null);

    let proxyWrapper = Gio.DBusProxy.makeProxyWrapper(MELANGE_IFACE);
    _melangeProxy = new proxyWrapper(Gio.DBus.session, 'org.Cinnamon.Melange', '/org/Cinnamon/Melange');

    _windowList = new WindowList(() => _dbusImpl.emit_signal('WindowListUpdate', null));
    _history = new History.HistoryManager({ gsettingsKey: HISTORY_KEY });
}

// should only used by main.js from _log()
function _emitLogUpdate() {
    if (!_initialized)
        return;
    _dbusImpl.emit_signal('LogUpdate', null);
}

function _update_keybinding() {
    let kb = _settings.get_strv("looking-glass-keybinding");
    Main.keybindingManager.addHotKeyArray("looking-glass-toggle", kb, toggle);
}


/*************************************************
 * "public" looking glass js methods             *
 *************************************************/

/**
 * addResult:
 * @command (string): JS code or display name
 * @result (any): value that corresponds to command, or null if command is JS
 * @tooltip (string): a tooltip for this result, or null
 *
 * Takes either javascript to evaluate, or a display string and a
 * result value and adds to the results list. If tooltip is not
 * provided then a generic evaluation time tooltip is used. When
 * object is provided command is not evaluated and the generic
 * tooltip always shows 0ms.
 */
function addResult(command, result=null, tooltip=null) {
    let duration = 0;
    if (!result) {
        let start = GLib.get_monotonic_time();
        result = tryEval(command);
        duration = ((GLib.get_monotonic_time() - start) / 1000).toFixed(1);
    }

    let index = _results.length;
    let [resultType, resultValue] = getObjInfo(result);

    _results.push({"o": result, "index": index});
    _rawResults.push({ command: command,
                       type: resultType,
                       object: resultValue,
                       index: index.toString(),
                       tooltip: tooltip || `Execution time: ${duration}ms` });

    _dbusImpl.emit_signal('ResultUpdate', null);

    _it = result;
}

/**
 * getExtensionList:
 *
 * Get an array of objects representing enabled extensions, conforming to
 * the GetExtensionList dbus method return signature.
 *
 * Returns (Array): an array of objects
 */
function getExtensionList() {
    try {
        let extensionList = Array(Extension.extensions.length);
        for (let i = 0; i < extensionList.length; i++) {
            let meta = Extension.extensions[i].meta;
            // There can be cases where we create dummy extension metadata
            // that's not really a proper extension. Don't bother with these.
            if (meta.name) {
                extensionList[i] = {
                    status: Extension.getMetaStateString(meta.state),
                    name: meta.name,
                    description: meta.description,
                    uuid: Extension.extensions[i].uuid,
                    folder: meta.path,
                    url: meta.url ? meta.url : '',
                    type: Extension.extensions[i].name,
                    error_message: meta.error ? meta.error : _("Loaded successfully"),
                    error: meta.error ? "true" : "false" // Must use string due to dbus restrictions
                };
            }
        }
        return [true, extensionList];
    } catch (e) {
        global.logError('Error getting the extension list', e);
        return [false, []];
    }
}

/**
 * getLatestWindowList:
 *
 * Get the list of open windows.
 *
 * Returns (Array): a list of "interesting" MetaWindows
 */
function getLatestWindowList() {
    return _windowList.latestWindowList;
}

/**
 * getObjInfo:
 * @obj (Any): any primitive or object
 *
 * Gets the type and value string representations of a primitive or object.
 *
 * Returns (Array): a 2-element array [type, value]
 */
function getObjInfo(obj) {
    let type, value;

    if (obj === null)
        type = 'null';
    else if (obj === undefined)
        type = 'undefined';

    if (type) {
        value = `[${type}]`;
    } else {
        // try to detect detailed type by string representation
        if (obj instanceof GObject.Object) {
            // work around Clutter.Actor.prototype.toString override
            value = GObject.Object.prototype.toString.call(obj);
        } else {
            // toString() throws when called on ByteArray(GBytes wrapper object in cjs)
            try {
                value = obj.toString();
            } catch (e) {
                value = '[error getting value]';
            }
        }

        type = typeof(obj);
        if (type === 'object') {
            if (value.search(IMPORT_RE) != -1) {
                type = 'importer';
            } else if (obj instanceof GIRepositoryNamespace) {
                type = 'GIRepositoryNamespace';
            } else {
                let matches = value.match(GI_RE);
                if (matches) {
                    if (matches[1] === 'prototype') {
                        type = 'prototype';
                    } else {
                        // 'instance'
                        type = GObject.type_name(obj.constructor.$gtype);
                    }
                } else if ('$gtype' in obj) {
                    type = GObject.type_name(obj.$gtype);
                } else if (Array.isArray(obj)) {
                    type = 'array';
                }
            }
        }

        // make empty strings/arrays obvious
        if (value === '')
            value = '[empty]';
    }

    return [type, value];
}

/**
 * getObjKeyInfos:
 * @obj (Object): an object to inspect
 *
 * Gets an array of objects which represent properties on obj, conforming to
 * the Inspect dbus method return signature.
 *
 * Returns (Array): an array of objects
 */
function getObjKeyInfos(obj) {
    let [type, ] = getObjInfo(obj);
    if (NON_INSPECTABLE_TYPES.includes(type))
        return [];

    let keys = [];
    if (['array', 'object'].includes(type))
        keys = _jsObjectGetKeys(obj, type);
    else
        keys = _giGetKeys(obj, type);
 
    let infos = [];
    for (let i = 0; i < keys.length; i++) {
        // muffin has some props that throw an error because they shouldn't be introspected
        try {
            let [t, v] = getObjInfo(obj[keys[i]]);
            infos.push({ name: keys[i].toString(),
                         type: t,
                         value: v,
                         shortValue: '' });
        } catch(e) {
        }
    }
    return infos;
}

/**
 * getResult:
 * @idx (Number): the result index
 *
 * Get the nth looking glass result value.
 *
 * Returns (Any): a result or null
 */
function getResult(idx) {
    if (idx > -1 && idx < _results.length)
        return _results[idx].o;
    return null;
}

/**
 * getWindow:
 * @idx (Number): an index
 *
 * Gets the nth window list entry.
 *
 * Returns (MetaWindow): a MetaWindow or null
 */
function getWindow(idx) {
    return _windowList.getWindowById(idx);
}

/**
 * getWindowApp:
 * @idx (Number): a window list index
 *
 * Gets the associated app of the nth window list entry.
 *
 * Returns (CinnamonApp): an app or null
 */
function getWindowApp(idx) {
    let metaWindow = _windowList.getWindowById(idx)
    if (!metaWindow)
        return null;

    let tracker = Cinnamon.WindowTracker.get_default();
    return tracker.get_window_app(metaWindow);
}

/**
 * inspect:
 * @path (String): a path or expression to an Object to inspect
 *
 * Evaluates path and returns the result's properties. This should only
 * be used for paths that evaluate to an Object.
 *
 * Returns (Array): an array of arrays with 2 strings [[name, value], ...]
 */
function inspect(path) {
    return getObjKeyInfos(tryEval(path));
}

/**
 * reloadExtension:
 * @uuid (String): the xlet's uuid
 * @type (Extension.Type): the xlet's type
 *
 * Reloads an xlet
 */
function reloadExtension(uuid, type) {
    Extension.reloadExtension(uuid, Extension.Type[type]);
}

/**
 * startInspector:
 * @doneCb (Function): a callback to invoke when done, or null
 *
 * Starts the actor inspection picker which allows the user
 * to select an actor that is visible on the stage. If the user
 * selects an actor, it will be placed at the end of the results
 * list. If a doneCb function is provided that will be called on
 * close, along with an emission of the InspectorDone dbus signal.
 */
function startInspector(doneCb=null) {
    try {
        let inspector = new Inspector();
        inspector.connect('target', (i, target, stageX, stageY) => {
            let name = `<inspect x:${stageX} y:${stageY}>`;
            addResult(name, target, "Inspected actor");
        });
        inspector.connect('closed', () => {
            if (typeof doneCb === 'function')
                doneCb();
            _dbusImpl.emit_signal('InspectorDone', null)
        });
    } catch (e) {
        global.logError('Error starting inspector', e);
    }
}

/**
 * toggle:
 *
 * Toggles visibility of the Melange window via dbus
 */
function toggle() {
    _melangeProxy.toggleRemote();
}

/**
 * tryEval:
 * @command (String): Javascript to evaluate
 *
 * Prepends the COMMAND_HEADER to and evaluates command. If the
 * script throws an Error, an Error object is returned.
 *
 * If an Error is returned, the object will include an extra
 * 'evalSource' property containing the full source code that
 * was being evaluated.
 *
 * Returns (Any): the resulting value, or an Error.
 */
function tryEval(command) {
    let evalSource = `${COMMAND_HEADER}\n\n${command}`;
    try {
        return eval(evalSource);
    } catch (e) {
        e.evalSource = evalSource;
        return e;
    }
}
