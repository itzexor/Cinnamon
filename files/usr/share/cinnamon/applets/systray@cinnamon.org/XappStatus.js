const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const Gtk = imports.gi.Gtk;
const GObject = imports.gi.GObject;
const St = imports.gi.St;
const XApp = imports.gi.XApp;

const SignalManager = imports.misc.signalManager;
const Util = imports.misc.util;

function calcStatusIconMenuOrigin(statusIcon) {
    let allocation = Cinnamon.util_get_transformed_allocation(statusIcon);
    let x = Math.round(allocation.x1 / global.ui_scale);
    let y = Math.round(allocation.y1 / global.ui_scale);
    let position;
    switch (statusIcon.applet.orientation) {
        case St.Side.TOP:
            y = Math.round(allocation.y2 / global.ui_scale);
            position = Gtk.PositionType.TOP;
            break;
        case St.Side.LEFT:
            x = Math.round(allocation.x2 / global.ui_scale);
            position = Gtk.PositionType.LEFT;
            break;
        case St.Side.RIGHT:
            position =  Gtk.PositionType.RIGHT;
            break;
        case St.Side.BOTTOM:
        default:
            position = Gtk.PositionType.BOTTOM;
    }
    return [x, y, position];
}

var XAppStatusIcon = GObject.registerClass(
class XAppStatusIcon extends St.BoxLayout {
    _init(applet, proxy, name) {
        super._init({ name: name,
                      style_class: 'applet-box',
                      reactive: true,
                      track_hover: true,
                      // The systray use a layout manager, we need to fill the space of the actor
                      // or otherwise the menu will be displayed inside the panel.
                      x_expand: true,
                      y_expand: true });

        this.applet = applet;
        this.proxy = proxy;
        this.iconName = null;
        this.tooltipText = "";

        if (applet.orientation == St.Side.LEFT || applet.orientation == St.Side.RIGHT) {
            this.set_x_align(Clutter.ActorAlign.FILL);
            this.set_y_align(Clutter.ActorAlign.END);
            this.set_vertical(true);
        }

        this.icon = new St.Icon();
        this.label = new St.Label({'y-align': St.Align.END });

        this.add_actor(this.icon);
        this.add_actor(this.label);

        this._proxy_prop_change_id = this.proxy.connect('g-properties-changed', (...args) => { this.on_properties_changed(...args) });

        this.setIconName(proxy.icon_name);
        this.setTooltipText(proxy.tooltip_text);
        this.setLabel(proxy.label);
        this.setVisible(proxy.visible);
    }

    on_properties_changed(proxy, changed_props, invalidated_props) {
        let prop_names = changed_props.deep_unpack();

        if ('IconName' in prop_names) {
            this.setIconName(proxy.icon_name);
        }
        if ('TooltipText' in prop_names) {
            this.setTooltipText(proxy.tooltip_text);
        }
        if ('Label' in prop_names) {
            this.setLabel(proxy.label);
        }
        if ('Visible' in prop_names) {
            this.setVisible(proxy.visible);
        }
    }

    setIconName(iconName) {
        if (iconName) {
            if (iconName.match(/-symbolic$/)) {
                this.icon.set_icon_type(St.IconType.SYMBOLIC);
            }
            else {
                this.icon.set_icon_type(St.IconType.FULLCOLOR);
            }
            this.iconName = iconName;
            this.icon.set_icon_name(iconName);
            this.icon.set_icon_size(this.applet.getPanelIconSize(this.icon.get_icon_type()));
            this.icon.show();
        }
        else {
            this.iconName = null;
            this.icon.hide();
        }
    }

    refreshIcon() {
        // Called when the icon theme, or the panel size change..
        if (!this.iconName)
            return;

        this.icon.set_icon_name(this.iconName);
        this.icon.set_icon_size(this.applet.getPanelIconSize(this.icon.get_icon_type()));
        this.icon.show();
    }

    setTooltipText(tooltipText) {
        if (tooltipText) {
            this.tooltipText = tooltipText;
        }
        else {
            this.tooltipText = "";
        }
    }

    setLabel(label) {
        if (label) {
            this.label.set_text(label);
            this.label.show();
        }
        else {
            this.label.hide();
        }
    }

    setVisible(visible) {
        if (visible) {
            this.show();
        }
        else {
            this.hide();
        }
    }

    vfunc_enter_event(event) {
        this.applet.set_applet_tooltip(this.tooltipText);
    }

    vfunc_leave_event(event) {
        this.applet.set_applet_tooltip("");
    }

    vfunc_button_press_event(event) {
        this.applet.set_applet_tooltip("");
        let [x, y, position] = calcStatusIconMenuOrigin(this);
        this.proxy.call_button_press_sync(x, y, event.button, event.time, position, null);
        return true;
    }

    vfunc_button_release_event(event) {
        let [x, y, position] = calcStatusIconMenuOrigin(this);
        this.proxy.call_button_release_sync(x, y, event.button, event.time, position, null);
        return true;
    }

    destroy() {
        this.proxy.disconnect(this._proxy_prop_change_id);
        super.destroy();
    }
});

var XAppStatusTray = GObject.registerClass(
class XAppStatusTray extends Clutter.Actor {
    _init(applet, vertical) {
        super._init({ layout_manager: new Clutter.BoxLayout({ spacing: 4, vertical: !!vertical }) });

        this.applet = applet;
        this.statusIcons = {};

        this.signalManager = new SignalManager.SignalManager(null);

        this.monitor = new XApp.StatusIconMonitor();
        this.signalManager.connect(this.monitor, "icon-added", this.onIconAdded, this);
        this.signalManager.connect(this.monitor, "icon-removed", this.onIconRemoved, this);

        this.signalManager.connect(Gtk.IconTheme.get_default(), 'changed', this.refreshIcons, this);
        this.signalManager.connect(global.settings, 'changed::panel-edit-mode', this.refreshIcons, this);
    }

    onIconAdded(monitor, icon_proxy) {
        let proxy_name = icon_proxy.get_name();

        if (this.statusIcons[proxy_name]) {
            return;
        }

        let statusIcon = new XAppStatusIcon(this.applet, icon_proxy, proxy_name);

        this.insert_child_at_index(statusIcon, 0);
        this.statusIcons[proxy_name] = statusIcon;
    }

    onIconRemoved(monitor, icon_proxy) {
        let proxy_name = icon_proxy.get_name();

        if (!(proxy_name in this.statusIcons)) {
            return;
        }

        this.statusIcons[proxy_name].destroy();
        delete this.statusIcons[proxy_name];
    }

    refreshIcons() {
        Util.each(this.statusIcons, icon => { icon.refreshIcon() });
    }

    setVertical(vertical) {
        this.layout_manager.set_vertical(!!vertical);
        this.refreshIcons();
    }

    destroy() {
        this.signalManager.disconnectAllSignals();
        delete this.applet;
        delete this.statusIcons;
        delete this.signalManager;
        delete this.monitor;
        super.destroy();
    }
});
