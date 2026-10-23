"""Keep an empty paragraph after clearing the DSH Desktop composer.

Exit DSH before running. The application archive is backed up before replacement.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct


def patch(app, backup_dir):
    target = 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'
    data = bytearray(app.read_bytes())
    header_length = struct.unpack_from('<I', data, 12)[0]
    header = json.loads(data[16:16 + header_length])
    base = 16 + (header_length + 3) // 4 * 4
    entry = header
    for part in target.split('/'):
        entry = entry['files'][part]
    start = base + int(entry['offset'])
    end = start + entry['size']
    original = bytes(data[start:end])
    source = original.decode('utf-8')
    section_start = source.index('\n\t\t\tclearCommittedDraft(prefixLength) {')
    section_end = source.index('\n\t\t\trestoreDraft(', section_start)
    section = source[section_start:section_end]
    old = 'const root = nl();\n\t\t\t\t\troot.clear();\n\t\t\t\t\troot.selectEnd();'
    new = 'nl().clear().append(es()).selectEnd();'
    if new in section:
        print('Already patched; no changes made.')
        return
    if section.count(old) != 1 or len(new) > len(old):
        raise RuntimeError('Composer source does not match the supported version')
    section = section.replace(old, new.ljust(len(old)), 1)
    patched = (source[:section_start] + section + source[section_end:]).encode('utf-8')
    if len(patched) != len(original):
        raise RuntimeError('Payload size changed')
    data[start:end] = patched
    integrity = entry.get('integrity')
    if integrity:
        if integrity['algorithm'] != 'SHA256':
            raise RuntimeError('Unsupported integrity algorithm')
        integrity['hash'] = hashlib.sha256(patched).hexdigest()
        block_size = integrity['blockSize']
        integrity['blocks'] = [
            hashlib.sha256(patched[i:i + block_size]).hexdigest()
            for i in range(0, len(patched), block_size)
        ]
        new_header = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(new_header) != header_length:
            raise RuntimeError('Header size changed')
        data[16:16 + header_length] = new_header
    backup_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(app.read_bytes()).hexdigest()
    backup = backup_dir / ('app.asar.before-composer-' + digest[:16])
    if backup.exists():
        if hashlib.sha256(backup.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Existing backup does not match the original archive')
    else:
        shutil.copy2(app, backup)
    staged = app.with_name('app.asar.composer-fix')
    if staged.exists():
        raise RuntimeError('Staging file already exists: ' + str(staged))
    staged.write_bytes(data)
    staged.replace(app)
    print(json.dumps({'patched': str(app), 'backup': str(backup)}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--asar', required=True, type=Path)
    parser.add_argument('--backup-dir', required=True, type=Path)
    args = parser.parse_args()
    patch(args.asar, args.backup_dir)
