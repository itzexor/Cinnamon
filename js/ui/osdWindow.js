const St = imports.gi.St;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Tweener = imports.ui.tweener;
const Gio = imports.gi.Gio;
const Meta = imports.gi.Meta;

const LEVEL_ANIMATION_TIME = 0.1;
const FADE_TIME = 0.1;
const HIDE_TIMEOUT = 1500;

const OSD_SIZE = 110;

function convertGdkIndex(monitorIndex) {
    let rect = global.screen.get_monitor_geometry(monitorIndex);
    let cx = rect.x + rect.width / 2;
    let cy = rect.y + rect.height / 2;
    for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
        let monitor = Main.layoutManager.monitors[i];
        if (cx >= monitor.x && cx < monitor.x + monitor.width &&
            cy >= monitor.y && cy < monitor.y + monitor.height)
            monitorIndex = i;
    }

    return monitorIndex;
};

class LevelBar {
    constructor() {
        this._level = 0;

        this.initial = true;

        this.actor = new St.Bin({ style_class: 'level',
                                  x_align: St.Align.START,
                                  y_fill: true,
                                  important: true });
        this._bar = new St.Widget({ style_class: 'level-bar',
                                    important: true });

        this.stored_actor_width = 0;
        this.max_bar_width = 0;

        this.actor.set_child(this._bar);
    }

    get level() {
        return this._level;
    }

    set level(value) {
        this._level = Math.max(0, Math.min(value, 100));

        /* Track our actor's width - if it changes, we can be certain some setting
         * or the theme changed.  Make sure we update it, as well as figure out our
         * level bar's allocation.
         */
        if (this.initial || (this.stored_actor_width != this.actor.width)) {
            this.initial = false;

            this.stored_actor_width = this.actor.width;

            let box = this.actor.get_theme_node().get_content_box(this.actor.get_allocation_box());

            this.max_bar_width = box.x2 - box.x1;
        }

        let newWidth = this.max_bar_width * (this._level / 100);

        if (newWidth != this._bar.width) {
            this._bar.width = newWidth;
        }
    }

    setLevelBarHeight(sizeMultiplier) {
        let themeNode = this.actor.get_theme_node();
        let height = themeNode.get_height();
        let newHeight = Math.floor(height * sizeMultiplier);
        this.actor.set_height(newHeight);
    }
};


class OsdWindow {
    constructor(monitorIndex) {
        this._monitorIndex = monitorIndex;
        this.actor = new St.BoxLayout({ style_class: 'osd-window',
                                        vertical: true,
                                        important: true });

        this._icon = new St.Icon();
        this.actor.add(this._icon, { expand: true });

        this._level = new LevelBar();
        this.actor.add(this._level.actor);

        this._hideTimeoutId = 0;
        this._blockedUnredirect = false;

        let osdSettings = new Gio.Settings({ schema_id: "org.cinnamon" });
        let settingsId = osdSettings.connect("changed::show-media-keys-osd",
                                             () => this._onOsdSettingsChanged(osdSettings.get_string("show-media-keys-osd")));

        this.actor.connect('destroy', () => {
            osdSettings.disconnect(settingsId);
            if (this._hideTimeoutId) {
                Mainloop.source_remove(this._hideTimeoutId);
                this._hideTimeoutId = 0;
            }
            this._reset();
            this.actor = null;
        });

        this._onOsdSettingsChanged(osdSettings.get_string("show-media-keys-osd"));

        this.actor.show_on_set_parent = false;
        Main.uiGroup.add_child(this.actor);
    }

    setIcon(icon) {
        this._icon.gicon = icon;
    }

    setLevel(level) {
        this._level.actor.visible = (level != undefined);
        if (level != undefined) {
            if (this.actor.visible)
                Tweener.addTween(this._level,
                                 { level: level,
                                   time: LEVEL_ANIMATION_TIME,
                                   transition: 'easeOutQuad' });
            else
                this._level.level = level;
        }
    }

    show() {
        if (!this._icon.gicon)
            return;

        if (this._hideTimeoutId)
            Mainloop.source_remove(this._hideTimeoutId);
        this._hideTimeoutId = Mainloop.timeout_add(HIDE_TIMEOUT, () => this._hide());

        if (this.actor.visible)
            return;

        if (!this._blockedUnredirect) {
            Meta.disable_unredirect_for_screen(global.screen);
            this._blockedUnredirect = true;
        }

        this._level.setLevelBarHeight(this._sizeMultiplier);
        this.actor.show();
        this.actor.opacity = 0;
        this.actor.raise_top();

        Tweener.addTween(this.actor,
                            { opacity: 255,
                              time: FADE_TIME,
                              transition: 'easeOutQuad' });
    }

    cancel() {
        if (!this._hideTimeoutId)
            return;

        Mainloop.source_remove(this._hideTimeoutId);
        this._hide();
    }

    _hide() {
        this._hideTimeoutId = 0;
        Tweener.addTween(this.actor,
                         { opacity: 0,
                           time: FADE_TIME,
                           transition: 'easeOutQuad',
                           onComplete: () => {
                               this.actor.hide();
                               this.setLevel(null);
                               this._reset();
                           }});
    }

    _reset() {
        if (this._blockedUnredirect) {
            Meta.enable_unredirect_for_screen(global.screen);
            this._blockedUnredirect = false;
        }
    }

    _onOsdSettingsChanged(currentSize) {
        let osdBaseSize;
        switch (currentSize) {
            case "disabled":
                osdBaseSize = null;
                break;
            case "small":
                this._sizeMultiplier = 0.7;
                osdBaseSize = Math.floor(OSD_SIZE * this._sizeMultiplier);
                break;
            case "large":
                this._sizeMultiplier = 1.0;
                osdBaseSize = OSD_SIZE;
                break;
            default:
                this._sizeMultiplier = 0.85;
                osdBaseSize = Math.floor(OSD_SIZE * this._sizeMultiplier);
        }

        let monitor = Main.layoutManager.monitors[this._monitorIndex];
        if (!monitor)
            return;

        let scaleW = monitor.width / 640.0;
        let scaleH = monitor.height / 480.0;
        let scale = Math.min(scaleW, scaleH);
        let popupSize = osdBaseSize * Math.max(1, scale);

        let scaleFactor = global.ui_scale;
        this._icon.icon_size = popupSize / (2 * scaleFactor);
        this.actor.set_size(popupSize, popupSize);
        this.actor.translation_y = (monitor.height + monitor.y) - (popupSize + (50 * scaleFactor));
        this.actor.translation_x = ((monitor.width / 2) + monitor.x) - (popupSize / 2);
    }
};

var OsdWindowManager = class {
    constructor() {
        this._osdWindows = [];

        Main.layoutManager.connect('monitors-changed', () => this._monitorsChanged());
        this._monitorsChanged();
    }

    _monitorsChanged() {
        this._osdWindows.forEach((w) => w.actor.destroy());
        this._osdWindows = [];

        for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
            this._osdWindows.push(new OsdWindow(i));
        }
    }

    _showOsdWindow(monitorIndex, icon, level) {
        this._osdWindows[monitorIndex].setIcon(icon);
        this._osdWindows[monitorIndex].setLevel(level);
        this._osdWindows[monitorIndex].show();
    }

    show(monitorIndex, icon, level, convertIndex) {
        if (monitorIndex != -1) {
            if (convertIndex)
                monitorIndex = convertGdkIndex(monitorIndex);
            for (let i = 0; i < this._osdWindows.length; i++) {
                if (i == monitorIndex)
                    this._showOsdWindow(i, icon, level);
                else
                    this._osdWindows[i].cancel();
            }
        } else {
            for (let i = 0; i < this._osdWindows.length; i++)
                this._showOsdWindow(i, icon, level);
        }
    }

    hideAll() {
        for (let i = 0; i < this._osdWindows.length; i++)
            this._osdWindows[i].cancel();
    }
};
