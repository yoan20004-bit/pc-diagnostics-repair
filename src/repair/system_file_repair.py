import subprocess
import sys

class SystemFileRepair:
    def __init__(self):
        pass

    def run_sfc(self):
        print("Starting System File Checker...")
        try:
            # Run the System File Checker tool
            result = subprocess.run(['sfc', '/scannow'], capture_output=True, text=True)
            print(result.stdout)
            if result.returncode == 0:
                print("System File Checker completed successfully.")
            else:
                print("System File Checker found issues that it could not fix.")
        except Exception as e:
            print(f"An error occurred: {str(e)}")

    def repair_files(self):
        print("Repairing corrupted system files...")
        self.run_sfc()
        print("Attempting to restore system integrity...")

if __name__ == '__main__':
    repair_tool = SystemFileRepair()
    repair_tool.repair_files()