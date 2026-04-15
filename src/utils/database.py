import sqlite3
from datetime import datetime

class CrashDatabase:
    def __init__(self, db_name='crash_history.db'):
        self.connection = sqlite3.connect(db_name)
        self.create_table()

    def create_table(self):
        query = ''' CREATE TABLE IF NOT EXISTS crashes ( \
            id INTEGER PRIMARY KEY AUTOINCREMENT, \
            blue_screen_error TEXT NOT NULL, \
            timestamp TEXT NOT NULL, \
            error_code TEXT, \
            repair_solution TEXT \ 
        ); '''
        self.connection.execute(query)
        self.connection.commit()

    def insert_crash(self, blue_screen_error, error_code, repair_solution):
        timestamp = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
        query = ''' INSERT INTO crashes (blue_screen_error, timestamp, error_code, repair_solution) \
                    VALUES (?, ?, ?, ?); '''
        self.connection.execute(query, (blue_screen_error, timestamp, error_code, repair_solution))
        self.connection.commit()

    def fetch_all_crashes(self):
        query = ''' SELECT * FROM crashes; '''
        cursor = self.connection.cursor()
        cursor.execute(query)
        return cursor.fetchall()

    def close(self):
        self.connection.close()