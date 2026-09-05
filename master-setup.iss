; Master Installer for MSG Arena Suite (Desktop App + Server Hosting)

[Setup]
AppName=MSG Arena
AppVersion=2.4.0
AppPublisher=Amni
DefaultDirName={userappdata}\HavenSetupTemp
DisableProgramGroupPage=yes
DisableDirPage=yes
Uninstallable=no
Compression=lzma2/ultra64
SolidCompression=yes
OutputDir=dist
OutputBaseFilename=MSG Arena-Full-Installer
PrivilegesRequired=lowest

[Files]
Source: "dist\Haven-Desktop-Setup.exe"; DestDir: "{tmp}"; Flags: ignoreversion
Source: "dist\Haven-Server-Setup.exe"; DestDir: "{tmp}"; Flags: ignoreversion

[Run]
; Run Desktop Installer silently (the NSIS electron-builder output supports /S)
Filename: "{tmp}\Haven-Desktop-Setup.exe"; Parameters: "/S"; StatusMsg: "Installing MSG Arena Desktop App..."

; Ask the user if they want to install the Server hosting
Filename: "{tmp}\Haven-Server-Setup.exe"; Description: "Install MSG Arena Server (Optional - Host your own server)"; Flags: postinstall nowait unchecked
