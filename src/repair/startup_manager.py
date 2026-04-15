import os
import psutil
import subprocess
from typing import List

class StartupManager:
    def __init__(self):
        self.startup_apps = self.get_startup_apps()

    def get_startup_apps(self) -> List[str]:
        # Get a list of startup applications according to the OS
        if os.name == 'nt':  # Windows
            return self.get_windows_startup_apps()
        elif os.name == 'posix':  # MacOS and Linux
            return self.get_posix_startup_apps()
        return []

    def get_windows_startup_apps(self) -> List[str]:
        # Example to retrieve Windows startup apps - implementation needed
        startup_apps = []  # Placeholder for actual retrieval logic
        # Use registry or other method to find startup apps
        return startup_apps

    def get_posix_startup_apps(self) -> List[str]:
        # Example - could be adjusted for different POSIX systems
        startup_apps = []  # Placeholder for actual retrieval logic
        return startup_apps

    def disable_startup_app(self, app_name: str) -> None:
        # Disable the specified startup application
        if os.name == 'nt':  # Windows
            # Logic to disable app on Windows
            subprocess.call(['powershell', 'Remove-Item', f"HKCU:\Software\Microsoft\Windows\CurrentVersion\Run\{app_name}"])
        elif os.name == 'posix':  # POSIX systems
            # Logic to manage startup on POSIX systems
            pass

    def reduce_boot_time(self) -> None:
        # Logic for reducing boot time (could involve disabling unnecessary services)
        pass

    def show_resource_usage(self):
        # Show resource usage per app running
        for proc in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_info']):
            try:
                print(f"PID: {proc.info['pid']}, Name: {proc.info['name']}, CPU: {proc.info['cpu_percent']}%, Memory: {proc.info['memory_info'].rss / (1024 * 1024)} MB")
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                pass

    def manage_startup_programs(self) -> None:
        # Logic to list, enable, and disable startup programs
        print("Current startup applications:")
        for app in self.startup_apps:
            print(app)

# Usage:
# manager = StartupManager()
# manager.show_resource_usage()
# manager.manage_startup_programs()