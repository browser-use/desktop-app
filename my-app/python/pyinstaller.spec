# pyinstaller.spec — PyInstaller spec for hello_daemon stub.
#
# Build with:  pyinstaller pyinstaller.spec
# from the my-app/python/ directory.
#
# Output:      dist/agent_daemon  (single-file executable, no Python install needed)
#
# For dual-arch release builds use python/build.sh which invokes this spec
# on macos-13 (Intel x64) and macos-14 (arm64) CI runners respectively.
#
# --onefile bundles the Python interpreter + stdlib + all imports into one
# self-extracting binary. The binary must be individually codesigned
# (scripts/sign-python.sh) BEFORE Electron Forge signs the outer .app bundle,
# otherwise Apple's notarization scanner rejects the nested unsigned binary.

import os

block_cipher = None

a = Analysis(
    ['agent_daemon.py'],
    pathex=[os.path.dirname(os.path.abspath(SPEC))],
    binaries=[],
    datas=[],
    hiddenimports=['agent.protocol', 'agent.events', 'agent.loop', 'agent.llm', 'agent.budget', 'agent.telemetry', 'agent.logger', 'agent.schemas', 'agent.exec_sandbox', 'agent.safe_exec_subprocess'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Exclude only modules definitely not needed by the real agent daemon.
        'tkinter',
        'unittest',
        'distutils',
        'curses',
        'turtle',
        'webbrowser',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='agent_daemon',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,         # do NOT strip — codesign verifier checks symbol table
    upx=False,           # do NOT use UPX — Apple notarization rejects UPX-packed binaries
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,        # daemon writes to stdout/stderr; keep console mode
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,    # arch determined by the Python interpreter running PyInstaller
    codesign_identity=None,   # signing done separately via scripts/sign-python.sh
    # entitlements_file is intentionally omitted here.
    # PyInstaller uses this for its own internal ad-hoc signing of bundled dylibs,
    # which runs from a temp workpath where relative paths break.
    # The real entitlements are applied by scripts/sign-python.sh on the final binary
    # using an absolute path: my-app/entitlements.plist
)
