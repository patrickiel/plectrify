#ifndef AppVersion
  #error AppVersion must be supplied with /DAppVersion=...
#endif
#ifndef StageDir
  #error StageDir must be supplied with /DStageDir=...
#endif
#ifndef OutputDir
  #define OutputDir "output"
#endif
#ifndef WebView2Installer
  #error WebView2Installer must be supplied with /DWebView2Installer=...
#endif
#ifndef VCRedistInstaller
  #error VCRedistInstaller must be supplied with /DVCRedistInstaller=...
#endif

[Setup]
AppId={{A7D2B4F0-4DF8-4B27-A8D7-7F6C5F9F1A01}
AppName=Plectrify
AppVersion={#AppVersion}
AppVerName=Plectrify {#AppVersion}
AppPublisher=Plectrify contributors
AppPublisherURL=https://github.com/patrickiel/plectrify
AppSupportURL=https://github.com/patrickiel/plectrify/issues
DefaultDirName={autopf}\Plectrify
DefaultGroupName=Plectrify
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
OutputDir={#OutputDir}
OutputBaseFilename=Plectrify-{#AppVersion}-win-x64-setup
UninstallDisplayIcon={app}\Plectrify.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ChangesAssociations=no
; Signing is intentionally disabled for the first release. A future release
; can add SignTool directives without changing the payload layout.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[InstallDelete]
; Vite filenames are content-hashed, so an upgrade must replace the UI tree
; instead of merging the new payload with assets left by an older release.
Type: filesandordirs; Name: "{app}\ui"
; Same reasoning for the shipped plugins: a bundle is a folder of many files,
; and a new version's must replace the old one rather than be merged into it.
Type: filesandordirs; Name: "{app}\plugins"

[Files]
Source: "{#StageDir}\Plectrify.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\ui\*"; DestDir: "{app}\ui"; Flags: ignoreversion recursesubdirs createallsubdirs
; The plugins Plectrify ships, as opposed to the ones it offers. These are part
; of the application: inside {app}, on the app's own scan path, never listed by
; the Packages panel, and removed with it. Neural Amp Modeler is here because
; every TONE3000 tone is a capture that loads into it.
Source: "{#StageDir}\plugins\*"; DestDir: "{app}\plugins"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\JUCE_LICENSE.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\SOURCE_OFFER.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\BUILD_INFO.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#WebView2Installer}"; DestDir: "{tmp}"; Flags: deleteafterinstall ignoreversion
Source: "{#VCRedistInstaller}"; DestDir: "{tmp}"; Flags: deleteafterinstall ignoreversion

[Icons]
Name: "{group}\Plectrify"; Filename: "{app}\Plectrify.exe"

[Run]
Filename: "{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft WebView2 Runtime..."; Flags: waituntilterminated
Filename: "{tmp}\VC_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing Microsoft Visual C++ Runtime..."; Flags: waituntilterminated
Filename: "{app}\Plectrify.exe"; Description: "Launch Plectrify"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; User data intentionally lives outside {app} and is preserved on uninstall.
; That now includes catalogue plugins in {commonappdata}\Plectrify\plugins:
; they are the user's own plugins, installed at their request and usable by
; other hosts, so uninstalling Plectrify must not take them away. Deleting the
; folder by hand removes them.
Type: filesandordirs; Name: "{app}\ui"
; Ours, unlike {commonappdata}\Plectrify\plugins above: shipped with the app,
; never the user's own install, so it goes when the app goes.
Type: filesandordirs; Name: "{app}\plugins"
