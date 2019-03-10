# ignore pylint warnings for pyinotify
# pylint: disable=no-member, invalid-name

import os
import pyinotify
from gi.repository import GLib, Gtk

class SelectWatchFileDialog(Gtk.Dialog):
    def __init__(self, parent):
        Gtk.Dialog.__init__(self, "Add a new file watcher", parent, 0)

        self.set_default_size(150, 100)

        label = Gtk.Label(label="")
        label.set_markup("<span size='large'>Add File Watch:</span>\n\n" +
                         "Please select a file to watch and a name for the tab\n")

        box = self.get_content_area()
        box.add(label)

        self.store = Gtk.ListStore(str, str)
        self.store.append([".xsession-errors", "~/.xsession-errors"])
        self.store.append(["custom", "<Select file>"])

        self.combo = Gtk.ComboBox.new_with_model(self.store)
        self.combo.connect("changed", self.on_combo_changed)
        renderer_text = Gtk.CellRendererText()
        self.combo.pack_start(renderer_text, True)
        self.combo.add_attribute(renderer_text, "text", 1)

        table = Gtk.Table(2, 2, False)
        table.attach(Gtk.Label(label="File: ", halign=Gtk.Align.START), 0, 1, 0, 1)
        table.attach(self.combo, 1, 2, 0, 1)
        table.attach(Gtk.Label(label="Name: ", halign=Gtk.Align.START), 0, 1, 1, 2)
        self.entry = Gtk.Entry()
        table.attach(self.entry, 1, 2, 1, 2)

        self.filename = None
        box.add(table)

        self.add_buttons("_Cancel", Gtk.ResponseType.CANCEL,
                         "_OK", Gtk.ResponseType.OK)
        self.show_all()

    def on_combo_changed(self, combo):
        tree_iter = combo.get_active_iter()
        if tree_iter is None:
            return True

        model = combo.get_model()
        name, self.filename = model[tree_iter][:2]
        self.entry.set_text(name)
        if name == "custom":
            new_file = self.select_file()
            if new_file is not None:
                combo.set_active_iter(self.store.insert(1, ["user", new_file]))
            else:
                combo.set_active(-1)
        return False

    def select_file(self):
        dialog = Gtk.FileChooserDialog("Please select a log file", self,
                                       Gtk.FileChooserAction.OPEN,
                                       (Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
                                        Gtk.STOCK_OPEN, Gtk.ResponseType.OK))

        filter_text = Gtk.FileFilter()
        filter_text.set_name("Text files")
        filter_text.add_mime_type("text/plain")
        dialog.add_filter(filter_text)

        filter_any = Gtk.FileFilter()
        filter_any.set_name("Any files")
        filter_any.add_pattern("*")
        dialog.add_filter(filter_any)

        response = dialog.run()
        result = None
        if response == Gtk.ResponseType.OK:
            result = dialog.get_filename()
        dialog.destroy()

        return result

    def run(self, *args, **kwargs):
        response = super().run(*args, **kwargs)
        out = None

        if (response == Gtk.ResponseType.OK and
                self.entry.get_text() != "" and
                self.filename is not None):
            expanded_path = os.path.expanduser(self.filename)
            if os.path.isfile(expanded_path):
                out = (self.entry.get_text(), expanded_path)

        self.destroy()
        return out

class FileWatchHandler(pyinotify.ProcessEvent):
    def my_init(self, view):
        self.view = view

    def process_IN_CLOSE_WRITE(self, event):
        self.view.get_updates()

    def process_IN_CREATE(self, event):
        self.view.get_updates()

    def process_IN_DELETE(self, event):
        self.view.get_updates()

    def process_IN_MODIFY(self, event):
        self.view.get_updates()

class FileWatchView(Gtk.ScrolledWindow):
    def __init__(self, filename):
        Gtk.ScrolledWindow.__init__(self)

        self.filename = filename
        self.changed = 0
        self.update_id = 0
        self.set_shadow_type(Gtk.ShadowType.ETCHED_IN)
        self.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)

        self.textview = Gtk.TextView()
        self.textview.set_editable(False)
        self.add(self.textview)

        self.textbuffer = self.textview.get_buffer()

        self.show_all()
        self.get_updates()

        handler = FileWatchHandler(view=self)
        watch_manager = pyinotify.WatchManager()
        self.notifier = pyinotify.ThreadedNotifier(watch_manager, handler)
        watch_manager.add_watch(filename, (pyinotify.IN_CLOSE_WRITE |
                                           pyinotify.IN_CREATE |
                                           pyinotify.IN_DELETE |
                                           pyinotify.IN_MODIFY))
        self.notifier.start()
        self.connect("destroy", self.on_destroy)
        self.connect("size-allocate", self.on_size_changed)

    def on_destroy(self, widget):
        if self.notifier:
            self.notifier.stop()
            self.notifier = None

    def on_size_changed(self, widget, bla):
        if self.changed > 0:
            end_iter = self.textbuffer.get_end_iter()
            self.textview.scroll_to_iter(end_iter, 0, False, 0, 0)
            self.changed -= 1

    def get_updates(self):
        # only update 2 times per second max
        # without this rate limiting, certain file modifications can cause
        # a crash at Gtk.TextBuffer.set_text()
        if self.update_id == 0:
            self.update_id = GLib.timeout_add(500, self.update)

    def update(self):
        self.changed = 2 # on_size_changed will be called twice, but only the second time is final
        self.textbuffer.set_text(open(self.filename, 'r').read())
        self.update_id = 0
        return False
