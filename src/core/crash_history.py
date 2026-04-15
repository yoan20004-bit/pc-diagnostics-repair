import sqlite3
import datetime

class CrashHistory:
    def __init__(self, db_name='crash_history.db'):
        # Connect to the database, create if it doesn't exist
        self.conn = sqlite3.connect(db_name)
        self.create_table()

    def create_table(self):
        # Create a table to store crash history if it doesn't already exist
        create_table_query = '''
        CREATE TABLE IF NOT EXISTS crashes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            error_code TEXT NOT NULL,
            description TEXT NOT NULL,
            solution TEXT NOT NULL
        )
        '''
        self.conn.execute(create_table_query)
        self.conn.commit()

    def log_crash(self, error_code, description, solution):
        # Log a new crash with the current timestamp
        timestamp = datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
        insert_query = '''
        INSERT INTO crashes (timestamp, error_code, description, solution)
        VALUES (?, ?, ?, ?)
        '''
        self.conn.execute(insert_query, (timestamp, error_code, description, solution))
        self.conn.commit()

    def fetch_crash_history(self):
        # Fetch all crash records
        select_query = '''
        SELECT * FROM crashes
        '''
        cursor = self.conn.execute(select_query)
        return cursor.fetchall()

    def close(self):
        # Close the database connection
        self.conn.close()

# Example usage:
# crash_history = CrashHistory()
# crash_history.log_crash('0x0000007B', 'Inaccessible Boot Device', 'Check your hard drive connections.')
# print(crash_history.fetch_crash_history())