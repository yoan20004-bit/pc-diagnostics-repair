import psutil
import os
import time

class MemoryOptimizer:
    def __init__(self):
        self.memory_threshold = 80  # percent

    def check_memory(self):
        memory_usage = psutil.virtual_memory().percent
        return memory_usage

    def terminate_hogging_apps(self):
        for proc in psutil.process_iter(['pid', 'name', 'memory_percent']):
            if proc.info['memory_percent'] > self.memory_threshold:
                print(f'Terminating {proc.info['name']} (PID: {proc.info['pid']}) - Memory Usage: {proc.info['memory_percent']:.2f}%')
                os.kill(proc.info['pid'], 9)  # Terminate process

    def free_memory(self):
        print('Freeing up memory...')
        self.terminate_hogging_apps()
        print('Memory optimization complete.')

if __name__ == '__main__':
    optimizer = MemoryOptimizer()
    while True:
        if optimizer.check_memory() > optimizer.memory_threshold:
            optimizer.free_memory()
        time.sleep(10)  # Check every 10 seconds