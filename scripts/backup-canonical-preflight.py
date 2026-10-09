from pathlib import Path
import datetime,json,os,sqlite3,sys,hashlib
source=Path('/var/www/hyper-summary-bot/data/hyper-summary.db')
destination=Path('/var/www/.backups/hyper-summary-bot')/datetime.datetime.now(datetime.timezone.utc).strftime('canonical-%Y%m%dT%H%M%SZ')
destination.mkdir(parents=True,mode=0o700);os.chmod(destination,0o700)
backup=destination/'before.db'
with sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True) as src:
    with sqlite3.connect(backup) as dst:
        src.backup(dst)
        integrity=dst.execute('PRAGMA integrity_check').fetchone()[0]
        rows=dst.execute('SELECT count(*) FROM messages').fetchone()[0]
os.chmod(backup,0o600)
if integrity!='ok':raise RuntimeError('Backup integrity check failed')
print(json.dumps({'backup_directory':str(destination),'integrity':integrity,'messages':rows,'sha256':hashlib.sha256(backup.read_bytes()).hexdigest()}))
