; ============================================================
; FolioPrism 棱阅 - Inno Setup 6 安装包脚本
;
; 编译（在仓库根目录执行）：
;   "D:\Claude\Inno Setup 6\ISCC.exe" installer\FolioPrism.iss
;
; 编译前必须先由 pack.js 生成 ..\dist\FolioPrism-win32-x64\
;   ELECTRON_ZIP_DIR="D:/Claude/electron-cache" npm run dist
;
; 本脚本只负责“安装/卸载/快捷方式”，不参与应用打包；
; 安装包与 portable zip 使用同一份 dist 产物，保证内容一致。
; ============================================================

#define AppName "FolioPrism 棱阅"
#define AppExeName "FolioPrism.exe"
#define AppVersion "1.5.2"
#define AppPublisher "YJH"
#define AppURL "https://github.com/1yanjinhui8/FolioPrism"
#define AppProgId "FolioPrism.Document"
; 允许命令行 /DSourceDir=... 覆盖，便于不打包整个应用就校验脚本语法。
#ifndef SourceDir
  #define SourceDir "..\dist\FolioPrism-win32-x64"
#endif

[Setup]
; AppId 一经发布就不能再改：升级安装、卸载注册表项都靠它识别。
; 当前 GUID 由 PowerShell [guid]::NewGuid() 生成，永久固定。
AppId={{6BC8CDD5-670B-43E7-A15F-6D05765FBE36}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}

; exe 文件属性里的版本信息（与 package.json 的 1.5.2 对应）
VersionInfoVersion=1.5.2.0
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=FolioPrism 棱阅 安装程序
VersionInfoProductName={#AppName}

; 按用户安装到 %LOCALAPPDATA%\Programs\FolioPrism，不弹 UAC。
; 与应用现有的 %APPDATA%\FolioPrism 数据目录布局一致。
DefaultDirName={localappdata}\Programs\FolioPrism
DefaultGroupName=FolioPrism
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ChangesAssociations=yes

; 仅支持 Windows 10/11 的 64 位环境（Electron 44 的要求）。
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; 产物输出到 dist\release\，该目录已被 .gitignore 忽略。
OutputDir=..\dist\release
OutputBaseFilename=FolioPrism-{#AppVersion}-win32-x64-setup

SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
LicenseFile=..\LICENSE

; LZMA2 固实压缩：安装包通常比 zip 更小，但编译较慢。
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern dynamic

; 安装时若应用正在运行，交给 Restart Manager 尝试关闭；
; 安装完成后由 [Run] 负责启动，不让安装器自动重启。
CloseApplications=yes
RestartApplications=no

[Languages]
; 中文放第一位：语言选择框默认选中简体中文，英文作为备选。
; ChineseSimplified.isl 来自 Inno Setup 官方仓库，已放入 installer\languages\。
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; 桌面快捷方式默认不勾选；开始菜单快捷方式始终创建。
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked
; 注册到 Windows「打开方式」与默认应用列表（默认勾选，不强行篡改现有默认程序）
Name: "registerassoc"; Description: "添加到 Windows「打开方式」和默认应用列表（不强行覆盖当前默认程序）"

[Files]
; 整目录安装，且保留子目录（locales\、resources\ 等）。
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

#define RegisterExt(str E) \
  "Root: HKCU; Subkey: ""Software\Classes\." + E + "\OpenWithProgids""; ValueType: string; ValueName: """ + AppProgId + """; ValueData: """"; Flags: uninsdeletevalue; Tasks: registerassoc" + NewLine + \
  "Root: HKCU; Subkey: ""Software\Classes\Applications\" + AppExeName + "\SupportedTypes""; ValueType: string; ValueName: ""." + E + """; ValueData: """"; Flags: uninsdeletevalue; Tasks: registerassoc" + NewLine + \
  "Root: HKCU; Subkey: ""Software\FolioPrism\Capabilities\FileAssociations""; ValueType: string; ValueName: ""." + E + """; ValueData: """ + AppProgId + """; Flags: uninsdeletevalue; Tasks: registerassoc"

[Registry]
; ProgID 与打开命令（全部写入 HKCU，无需管理员权限，卸载时自动清理）
Root: HKCU; Subkey: "Software\Classes\{#AppProgId}"; ValueType: string; ValueName: ""; ValueData: "{#AppName} 文档"; Flags: uninsdeletekey; Tasks: registerassoc
Root: HKCU; Subkey: "Software\Classes\{#AppProgId}"; ValueType: string; ValueName: "FriendlyTypeName"; ValueData: "{#AppName} 文档"; Tasks: registerassoc
Root: HKCU; Subkey: "Software\Classes\{#AppProgId}\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExeName},0"; Tasks: registerassoc
Root: HKCU; Subkey: "Software\Classes\{#AppProgId}\shell\open"; ValueType: string; ValueName: ""; ValueData: "用 {#AppName} 打开"; Tasks: registerassoc
Root: HKCU; Subkey: "Software\Classes\{#AppProgId}\shell\open"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\{#AppExeName},0"; Tasks: registerassoc
Root: HKCU; Subkey: "Software\Classes\{#AppProgId}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""; Tasks: registerassoc

; Applications 项（让右键「打开方式」展示友好名称与图标）
Root: HKCU; Subkey: "Software\Classes\Applications\{#AppExeName}"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "{#AppName}"; Flags: uninsdeletekey; Tasks: registerassoc
Root: HKCU; Subkey: "Software\Classes\Applications\{#AppExeName}\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExeName},0"; Tasks: registerassoc
Root: HKCU; Subkey: "Software\Classes\Applications\{#AppExeName}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""; Tasks: registerassoc

; Windows 10/11「设置 → 应用 → 默认应用」Capabilities 注册
Root: HKCU; Subkey: "Software\FolioPrism"; Flags: uninsdeletekey; Tasks: registerassoc
Root: HKCU; Subkey: "Software\FolioPrism\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "{#AppName}"; Flags: uninsdeletekey; Tasks: registerassoc
Root: HKCU; Subkey: "Software\FolioPrism\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "FolioPrism（棱阅）：本地优先的多媒体文档与双语阅读工作台"; Tasks: registerassoc
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "FolioPrism"; ValueData: "Software\FolioPrism\Capabilities"; Flags: uninsdeletevalue; Tasks: registerassoc

; 文档、网页与表格
#emit RegisterExt("md")
#emit RegisterExt("markdown")
#emit RegisterExt("txt")
#emit RegisterExt("log")
#emit RegisterExt("text")
#emit RegisterExt("plaintext")
#emit RegisterExt("tsv")
#emit RegisterExt("pdf")
#emit RegisterExt("docx")
#emit RegisterExt("xlsx")
#emit RegisterExt("xls")
#emit RegisterExt("csv")
#emit RegisterExt("html")
#emit RegisterExt("htm")

; 代码与配置文件
#emit RegisterExt("json")
#emit RegisterExt("yaml")
#emit RegisterExt("yml")
#emit RegisterExt("toml")
#emit RegisterExt("ini")
#emit RegisterExt("conf")
#emit RegisterExt("xml")
#emit RegisterExt("sql")
#emit RegisterExt("js")
#emit RegisterExt("mjs")
#emit RegisterExt("cjs")
#emit RegisterExt("ts")
#emit RegisterExt("jsx")
#emit RegisterExt("tsx")
#emit RegisterExt("py")
#emit RegisterExt("java")
#emit RegisterExt("c")
#emit RegisterExt("cc")
#emit RegisterExt("cpp")
#emit RegisterExt("h")
#emit RegisterExt("hpp")
#emit RegisterExt("cs")
#emit RegisterExt("go")
#emit RegisterExt("rs")
#emit RegisterExt("php")
#emit RegisterExt("rb")
#emit RegisterExt("sh")
#emit RegisterExt("bat")
#emit RegisterExt("ps1")
#emit RegisterExt("css")
#emit RegisterExt("scss")
#emit RegisterExt("less")
#emit RegisterExt("vue")
#emit RegisterExt("svelte")
#emit RegisterExt("swift")
#emit RegisterExt("kt")
#emit RegisterExt("r")
#emit RegisterExt("lua")
#emit RegisterExt("dart")
#emit RegisterExt("pl")

; 图片与音视频
#emit RegisterExt("png")
#emit RegisterExt("jpg")
#emit RegisterExt("jpeg")
#emit RegisterExt("gif")
#emit RegisterExt("webp")
#emit RegisterExt("svg")
#emit RegisterExt("bmp")
#emit RegisterExt("ico")
#emit RegisterExt("avif")
#emit RegisterExt("mp4")
#emit RegisterExt("webm")
#emit RegisterExt("ogv")
#emit RegisterExt("mov")
#emit RegisterExt("m4v")
#emit RegisterExt("mkv")
#emit RegisterExt("mp3")
#emit RegisterExt("wav")
#emit RegisterExt("m4a")
#emit RegisterExt("flac")
#emit RegisterExt("ogg")

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,FolioPrism}"; Flags: nowait postinstall skipifsilent

; 注意：这里故意没有 [UninstallDelete]。
; 卸载只删除安装目录，%APPDATA%\FolioPrism 中的阅读进度与设置会保留。
; 若以后要提供“彻底清除数据”，应做成显式复选框，而不是卸载时静默删除。
