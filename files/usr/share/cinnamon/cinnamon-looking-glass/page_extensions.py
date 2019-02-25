#!/usr/bin/python3

import pageutils
import os
from gi.repository import Gtk, Gdk

INSTANCES_JS = {
    'Applet': 'imports.ui.appletManager.definitions.filter(d => d.uuid === "{}")',
    'Desklet': 'imports.ui.deskletManager.definitions.filter(d => d.uuid === "{}")'
}

class ModulePage(pageutils.BaseListView):
    def __init__(self, parent):
        store = Gtk.ListStore(str, str, str, str, str, str, str, bool, str)
        pageutils.BaseListView.__init__(self, store)
        self.parent = parent

        self.createTextColumn(0, "Status")
        self.createTextColumn(1, "Type")
        self.createTextColumn(2, "Name")
        self.createTextColumn(3, "Description")
        self.getUpdates()
        lookingGlassProxy.connect("ExtensionListUpdate", self.getUpdates)
        lookingGlassProxy.addStatusChangeCallback(self.onStatusChange)
        self.treeView.set_tooltip_column(8)

        self.popup = Gtk.Menu()

        self.inspectInstances = Gtk.MenuItem('Inspect Instances')
        self.inspectInstances.connect("activate", self.onInspectInstances)
        self.popup.append(self.inspectInstances)

        self.viewSource = Gtk.MenuItem('View Source')
        self.viewSource.connect("activate", self.onViewSource)
        self.popup.append(self.viewSource)

        reloadCode = Gtk.MenuItem('Reload Code')
        reloadCode.connect("activate", self.onReloadCode)
        self.popup.append(reloadCode)

        self.viewWebPage = Gtk.MenuItem('View Web Page')
        self.viewWebPage.connect("activate", self.onViewWebPage)
        self.popup.append(self.viewWebPage)

        self.popup.show_all()

        self.treeView.connect("button-press-event", self.on_button_press_event)

    def onInspectInstances(self, *args):
        treeIter = self.store.get_iter(self.selectedPath)
        uuid = self.store.get_value(treeIter, 4)
        xletType = self.store.get_value(treeIter, 1)
        print(INSTANCES_JS[xletType], xletType)
        melangeApp.pages["inspect"].updateInspector(INSTANCES_JS[xletType].format(uuid),
                                                    "array",
                                                    "xlet instances",
                                                    "")

    def onViewSource(self, menuItem):
        treeIter = self.store.get_iter(self.selectedPath)
        folder = self.store.get_value(treeIter, 5)
        os.system("xdg-open \"" + folder + "\" &")

    def onReloadCode(self, menuItem):
        treeIter = self.store.get_iter(self.selectedPath)
        uuid = self.store.get_value(treeIter, 4)
        xletType = self.store.get_value(treeIter, 1)
        lookingGlassProxy.ReloadExtension(uuid, xletType.upper())

    def onViewWebPage(self, menuItem):
        treeIter = self.store.get_iter(self.selectedPath)
        url = self.store.get_value(treeIter, 6)
        os.system("xdg-open \"" + url + "\" &")

    def on_button_press_event(self, treeview, event):
        x = int(event.x)
        y = int(event.y)
        pthinfo = treeview.get_path_at_pos(x, y)
        if pthinfo is not None:
            path, col, cellx, celly = pthinfo
            self.selectedPath = path
            treeview.grab_focus()
            treeview.set_cursor( path, col, 0)

            treeIter = self.store.get_iter(self.selectedPath)

        if event.button == 3:
            if pthinfo is not None:
                uuid = self.store.get_value(treeIter, 4)
                url = self.store.get_value(treeIter, 6)
                xletType = self.store.get_value(treeIter, 1)

                self.inspectInstances.set_sensitive(xletType == 'Applet' or xletType == 'Desklet')

                self.viewWebPage.set_sensitive(url != "")
                self.viewSource.set_label(uuid + " (View Source)")
                self.popup.popup( None, None, None, None, event.button, event.time)
            return True
        elif event.type == Gdk.EventType.DOUBLE_BUTTON_PRESS:
            if pthinfo is not None:
                error = self.store.get_value(treeIter, 7)
                if error:
                    self.parent.activatePage("log")

    def onStatusChange(self, online):
        if online:
            self.getUpdates()

    def getUpdates(self):
        success, data = lookingGlassProxy.GetExtensionList()
        if success:
            self.store.clear()
            for item in data:
                self.store.append([item["status"], item["type"], item["name"], item["description"], item["uuid"], item["folder"], item["url"], item["error"] == "true", item["error_message"]])
