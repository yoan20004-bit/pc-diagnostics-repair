import psutil
import time
import logging

# Configure logging
logging.basicConfig(filename='system_monitor.log', level=logging.INFO)

class RealTimeAlertSystem:
    def __init__(self, cpu_threshold=80, ram_threshold=80, disk_threshold=80, temp_threshold=75):
        self.cpu_threshold = cpu_threshold
        self.ram_threshold = ram_threshold
        self.disk_threshold = disk_threshold
        self.temp_threshold = temp_threshold

    def check_cpu(self):
        cpu_usage = psutil.cpu_percent()
        if cpu_usage > self.cpu_threshold:
            logging.warning(f'CPU usage high: {cpu_usage}%')

    def check_ram(self):
        ram_usage = psutil.virtual_memory().percent
        if ram_usage > self.ram_threshold:
            logging.warning(f'RAM usage high: {ram_usage}%')

    def check_disk(self):
        disk_usage = psutil.disk_usage('/').percent
        if disk_usage > self.disk_threshold:
            logging.warning(f'Disk usage high: {disk_usage}%')

    def check_temperature(self):
        # Placeholder for temperature checking logic; specific implementation may vary
        temp = self.get_cpu_temperature()  # Implement this function based on the platform
        if temp > self.temp_threshold:
            logging.warning(f'High CPU temperature: {temp}°C')

    def get_cpu_temperature(self):
        # This method should be implemented according to the operating system
        # Returning a dummy value for demonstration
        return 70  # Placeholder value

    def monitor(self):
        while True:
            self.check_cpu()
            self.check_ram()
            self.check_disk()
            self.check_temperature()
            time.sleep(5)  # Sleep for a while before the next check

if __name__ == '__main__':
    alert_system = RealTimeAlertSystem()
    alert_system.monitor()
