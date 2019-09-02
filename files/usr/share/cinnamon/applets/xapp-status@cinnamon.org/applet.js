const Lang = imports.lang;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const Clutter = imports.gi.Clutter;
const Interfaces = imports.misc.interfaces;
const Applet = imports.ui.applet;
const Main = imports.ui.main;
const SignalManager = imports.misc.signalManager;
const Gtk = imports.gi.Gtk;
const GObject = imports.gi.GObject;

const XAppStatusIcon = GObject.registerClass(
class XAppStatusIcon extends St.BoxLayout {
    _init(applet, busName, owner) {
        super._init({style_class: 'applet-box',
                     reactive: true,
                     track_hover: true,
                     // The systray use a layout manager, we need to fill the space of the actor
                     // or otherwise the menu will be displayed inside the panel.
                     x_expand: true,
                     y_expand: true });

        this.owner = owner;
        this.busName = busName;
        this.applet = applet;

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

        Interfaces.getDBusProxyWithOwnerAsync("org.x.StatusIcon",
                                              this.busName,
                                              Lang.bind(this, function(proxy, error) {
                                                  if (error) {
                                                      global.logError(error);
                                                  } else {
                                                      this.proxy = proxy;
                                                      this.on_dbus_acquired();
                                                  }


                                              }));

        Interfaces.getDBusPropertiesAsync(this.busName,
                                          "/org/x/StatusIcon",
                                          Lang.bind(this, function(proxy, error) {
                                              if (error) {
                                                  global.logError(error);
                                              } else {
                                                  this.property_proxy = proxy;
                                                  this.on_dbus_acquired();
                                              }
                                          }));
    }

    vfunc_enter_event(event) {
        this.applet.set_applet_tooltip(this.tooltipText);
    }

    vfunc_leave_event(event) {
        this.applet.set_applet_tooltip("");
    }

    vfunc_button_press_event(event) {
        this.applet.set_applet_tooltip("");
        let [x, y] = this.get_transformed_position();
        x = Math.round(x / global.ui_scale);
        y = Math.round(y / global.ui_scale);
        if (event.button == 1) {
            this.proxy.LeftClickRemote(x, y, event.time, event.button);
        }
        else if (event.button == 2) {
            this.proxy.MiddleClickRemote(x, y, event.time, event.button);
        }
        else if (event.button == 3) {
            return true;
        }
        return false;
    }

    vfunc_button_release_event(event) {
        let [x, y] = this.get_transformed_position();
        x = Math.round(x / global.ui_scale);
        y = Math.round(y / global.ui_scale);
        if (event.button == 3) {
            this.proxy.RightClickRemote(x, y, event.time, event.time);
            return true;
        }
        return false;
    }

    on_dbus_acquired() {
        if (!this.property_proxy || !this.proxy)
            return;

        global.log("Adding XAppStatusIcon: " + this.proxy.Name + " (" + this.busName + ")");

        this.setIconName(this.proxy.IconName);
        this.setTooltipText(this.proxy.TooltipText);
        this.setLabel(this.proxy.Label);
        this.setVisible(this.proxy.Visible);

        this.propertyChangedId = this.property_proxy.connectSignal('PropertiesChanged', Lang.bind(this, function(proxy, sender, [iface, properties]) {
            if (properties.IconName)
                this.setIconName(properties.IconName.unpack());
            if (properties.TooltipText)
                this.setTooltipText(properties.TooltipText.unpack());
            if (properties.Label)
                this.setLabel(properties.Label.unpack());
            if (properties.Visible)
                this.setVisible(properties.Visible.unpack());
        }));
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
        if (this.iconName) {
            this.icon.set_icon_name(this.iconName);
            this.icon.set_icon_size(this.applet.getPanelIconSize(this.icon.get_icon_type()));
            this.icon.show();
        }
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

    destroy() {
        if (this.property_proxy)
            this.property_proxy.disconnectSignal(this.propertyChangedId);
        super.destroy();
    }
});

class CinnamonXAppStatusApplet extends Applet.Applet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.orientation = orientation;

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this.actor.remove_style_class_name('applet-box');
        this.actor.set_style_class_name('systray');
        this.actor.set_important(true);  // ensure we get class details from the default theme if not present

        let manager;
        if (this.orientation == St.Side.TOP || this.orientation == St.Side.BOTTOM) {
            manager = new Clutter.BoxLayout( { spacing: 4,
                                               orientation: Clutter.Orientation.HORIZONTAL });
        } else {
            manager = new Clutter.BoxLayout( { spacing: 4,
                                               orientation: Clutter.Orientation.VERTICAL });
        }
        this.manager = manager;
        this.manager_container = new Clutter.Actor( { layout_manager: manager } );
        this.actor.add_actor (this.manager_container);
        this.manager_container.show();

        this.statusIcons = {};

        Gio.bus_own_name(Gio.BusType.SESSION,
                         "org.x.StatusApplet.PID-" + global.get_pid(),
                         Gio.BusNameOwnerFlags.NONE,
                         null,
                         null,
                         null);

        Interfaces.getDBusAsync(Lang.bind(this, function (proxy, error) {
            this.dbus = proxy;

            // Find all the XApp Status Icons on DBus
            let name_regex = /^org\.x\.StatusIcon\./;
            this.dbus.ListNamesRemote(Lang.bind(this,
                function(names) {
                    for (let n in names[0]) {
                        let name = names[0][n];
                        if (name_regex.test(name)) {
                            this.dbus.GetNameOwnerRemote(name, Lang.bind(this,
                                function(owner) {
                                    this.addStatusIcon(name, owner);
                                }
                            ));
                        }
                    }
                }
            ));

            // Listen on DBUS in case some of them go, or new ones appear
            this.ownerChangedId = this.dbus.connectSignal('NameOwnerChanged', Lang.bind(this,
                function(proxy, sender, [name, old_owner, new_owner]) {
                    if (name_regex.test(name)) {
                        if (new_owner && !old_owner)
                            this.addStatusIcon(name, new_owner);
                        else if (old_owner && !new_owner)
                            this.removeStatusIcon(name, old_owner);
                        else
                            this.changeStatusIconOwner(name, old_owner, new_owner);
                    }
                }
            ));
        }));

        this.signalManager = new SignalManager.SignalManager(null);
        this.signalManager.connect(Gtk.IconTheme.get_default(), 'changed', this.on_icon_theme_changed, this);
        this.signalManager.connect(global.settings, 'changed::panel-edit-mode', this.on_panel_edit_mode_changed, this);
    }

    addStatusIcon(busName, owner) {
        if (this.statusIcons[owner]) {
            let prevName = this.statusIcons[owner].busName;
            if (this._isInstance(busName) && !this._isInstance(prevName))
                this.statusIcons[owner].busName = busName;
            else
                return;
        } else if (owner) {
            let statusIcon = new XAppStatusIcon(this, busName, owner);
            this.manager_container.insert_child_at_index(statusIcon, 0);
            this.statusIcons[owner] = statusIcon;
        }
    }

    removeStatusIcon(busName, owner) {
        if (this.statusIcons[owner] && this.statusIcons[owner].busName == busName) {
            this.manager_container.remove_child(this.statusIcons[owner]);
            this.statusIcons[owner].destroy();
            delete this.statusIcons[owner];
        }
    }

    changeStatusIconOwner(busName, oldOwner, newOwner) {
        if (this.statusIcons[oldOwner] && busName == this.statusIcons[oldOwner].busName) {
            this.statusIcons[newOwner] = this.statusIcons[oldOwner];
            this.statusIcons[newOwner].owner = newOwner;
            delete this.statusIcons[oldOwner];
        }
    }

    refreshIcons() {
        for (let owner in this.statusIcons) {
            let icon = this.statusIcons[owner];
            icon.refreshIcon();
        }
    }

    on_panel_icon_size_changed(size) {
        this.refreshIcons();
    }

    on_icon_theme_changed() {
        this.refreshIcons();
    }

    on_applet_removed_from_panel() {
        this.signalManager.disconnectAllSignals();
    }

    on_panel_edit_mode_changed() {
        let reactive = !global.settings.get_boolean('panel-edit-mode');
        for (let owner in this.statusIcons) {
            let icon = this.statusIcons[owner];
            icon.actor.reactive = reactive;
        }
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new CinnamonXAppStatusApplet(orientation, panel_height, instance_id);
}
