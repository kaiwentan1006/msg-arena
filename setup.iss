; MSG Arena Server Inno Setup Script
[Setup]
AppName=MSG Arena Server
AppVersion=2.4.0
AppPublisher=Amni
DefaultDirName={userappdata}\HavenServer
DefaultGroupName=MSG Arena Server
UninstallDisplayIcon={app}\public\favicon.svg
Compression=lzma2/ultra64
SolidCompression=yes
OutputDir=dist
OutputBaseFilename=MSG Arena-Server-Setup
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
DisableDirPage=no

[Files]
Source: "*"; DestDir: "{app}"; Excludes: "node_modules,dist,.git,.github,.env,haven.db*,certs,uploads,*.exe,master-setup.iss"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Start MSG Arena Server"; Filename: "{app}\Start MSG Arena.bat"; IconFilename: "{app}\public\favicon.svg"
Name: "{group}\Uninstall MSG Arena"; Filename: "{uninstallexe}"
Name: "{commondesktop}\Start MSG Arena Server"; Filename: "{app}\Start MSG Arena.bat"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Run]
Filename: "{app}\Install MSG Arena.bat"; Description: "Launch Setup Wizard (Installs Node.js & Configures Server)"; Flags: postinstall nowait
