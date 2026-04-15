import sys
from PyQt6 import QtWidgets, QtCore, QtGui

class ModernHub(QtWidgets.QWidget):
    def __init__(self):
        super().__init__()
        self.initUI()

    def initUI(self):
        # Set the style sheet for dark theme with accents
        self.setStyleSheet("""
            QWidget {
                background-color: #1E1E1E;
                color: white;
            }
            QPushButton {
                background-color: #00BFFF;
                border: none;
                padding: 10px;
            }
            QPushButton:hover {
                background-color: #FF6B6B;
            }
            QLabel {
                font-size: 14px;
            }
        """
        )

        # Create layout
        layout = QtWidgets.QVBoxLayout()

        # Dashboard Widgets
        self.cpuLabel = QtWidgets.QLabel('CPU Usage: 35%')
        self.ramLabel = QtWidgets.QLabel('RAM Usage: 40%')
        self.diskLabel = QtWidgets.QLabel('Disk Usage: 55%')

        layout.addWidget(self.cpuLabel)
        layout.addWidget(self.ramLabel)
        layout.addWidget(self.diskLabel)

        # Crash History
        self.crashHistory = QtWidgets.QTextEdit()
        self.crashHistory.setPlainText("Sample Crash Data:\n- App crashed at 2026-03-28 12:00:00\n- App crashed at 2026-04-01 15:30:00")
        layout.addWidget(self.crashHistory)

        # BSOD Tracker
        self.bsodTracker = QtWidgets.QLabel('BSOD Tracker: No errors to report')
        layout.addWidget(self.bsodTracker)

        # Quick Action Buttons
        self.quickActionBtn = QtWidgets.QPushButton('Quick Action')
        layout.addWidget(self.quickActionBtn)

        # Set layout
        self.setLayout(layout)
        self.setWindowTitle('PC Diagnostics & Repair - Modern Hub')
        self.resize(400, 300)

if __name__ == '__main__':
    app = QtWidgets.QApplication(sys.argv)
    hub = ModernHub()
    hub.show()
    sys.exit(app.exec())
