import tkinter as tk
from tkinter import ttk, messagebox
import json

class CrashHistoryView(tk.Frame):
    def __init__(self, master=None):
        super().__init__(master)
        self.master = master
        self.pack()
        self.create_widgets()

    def create_widgets(self):
        self.title = tk.Label(self, text="Crash History")
        self.title.pack()

        # Search functionality
        self.search_label = tk.Label(self, text="Search:")
        self.search_label.pack()
        self.search_entry = tk.Entry(self)
        self.search_entry.pack()
        self.search_button = tk.Button(self, text="Search", command=self.search_crashes)
        self.search_button.pack()

        # Filters
        self.filter_frame = tk.Frame(self)
        self.filter_frame.pack()

        self.filter_label = tk.Label(self.filter_frame, text="Filter by:")
        self.filter_label.pack(side=tk.LEFT)

        self.filter_combobox = ttk.Combobox(self.filter_frame, values=["All", "Critical", "Warning", "Info"])
        self.filter_combobox.set("All")
        self.filter_combobox.pack(side=tk.LEFT)
        self.filter_combobox.bind('<<ComboboxSelected>>', self.filter_crashes)

        # Crash history display
        self.crash_tree = ttk.Treeview(self)
        self.crash_tree['columns'] = ("timestamp", "error_type", "message")
        self.crash_tree.column("timestamp", width=150)
        self.crash_tree.column("error_type", width=100)
        self.crash_tree.column("message", width=300)

        self.crash_tree.heading("timestamp", text="Timestamp")
        self.crash_tree.heading("error_type", text="Error Type")
        self.crash_tree.heading("message", text="Message")
        self.crash_tree.pack()

        # Export button
        self.export_button = tk.Button(self, text="Export", command=self.export_data)
        self.export_button.pack() 

        # Load crash history data
        self.load_crash_history()

    def load_crash_history(self):
        try:
            with open('crash_history.json', 'r') as file:
                self.crash_data = json.load(file)
            self.populate_tree()
        except FileNotFoundError:
            messagebox.showerror("Error", "Crash history file not found.")

    def populate_tree(self):
        for crash in self.crash_data:
            self.crash_tree.insert('', 'end', values=(crash['timestamp'], crash['error_type'], crash['message']))

    def search_crashes(self):
        search_term = self.search_entry.get().lower()
        for item in self.crash_tree.get_children():
            self.crash_tree.delete(item)
        for crash in self.crash_data:
            if search_term in crash['message'].lower():
                self.crash_tree.insert('', 'end', values=(crash['timestamp'], crash['error_type'], crash['message']))

    def filter_crashes(self, event):
        filter_value = self.filter_combobox.get()
        for item in self.crash_tree.get_children():
            self.crash_tree.delete(item)
        for crash in self.crash_data:
            if filter_value == "All" or filter_value.lower() in crash['error_type'].lower():
                self.crash_tree.insert('', 'end', values=(crash['timestamp'], crash['error_type'], crash['message']))

    def export_data(self):
        with open('exported_crash_history.json', 'w') as file:
            json.dump(self.crash_data, file)
        messagebox.showinfo("Success", "Crash history exported successfully.")

if __name__ == '__main__':
    root = tk.Tk()
    app = CrashHistoryView(master=root)
    app.mainloop()