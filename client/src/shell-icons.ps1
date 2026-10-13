# 탐색기와 같은 셸 아이콘을 PNG(base64)로 추출한다.
# 입력: $env:RD_ICONS = JSON [{ key, path, attr }]  (attr=true 이면 실제 파일 없이 확장자로 조회)
# 출력: JSON { key: { s: <32px png>, l: <48px png> } }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RdShell {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SHFILEINFO {
    public IntPtr hIcon; public int iIcon; public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SHGetFileInfo(string path, uint attr, ref SHFILEINFO info, uint size, uint flags);
  [DllImport("shell32.dll")]
  public static extern int SHGetImageList(int iImageList, ref Guid riid, out IntPtr ppv);
  [DllImport("comctl32.dll")]
  public static extern IntPtr ImageList_GetIcon(IntPtr himl, int i, uint flags);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  public static int Index(string path, bool useAttr, bool isDir) {
    var info = new SHFILEINFO();
    uint flags = 0x4000; // SHGFI_SYSICONINDEX
    uint attr = 0;
    if (useAttr) { flags |= 0x10; attr = isDir ? 0x10u : 0x80u; } // SHGFI_USEFILEATTRIBUTES
    SHGetFileInfo(path, attr, ref info, (uint)Marshal.SizeOf(info), flags);
    return info.iIcon;
  }
  public static IntPtr Icon(int list, int index) {
    var iid = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
    IntPtr himl;
    if (SHGetImageList(list, ref iid, out himl) != 0) return IntPtr.Zero;
    return ImageList_GetIcon(himl, index, 1); // ILD_TRANSPARENT
  }
}
'@
[RdShell]::SetProcessDPIAware() | Out-Null

function ToPng([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return $null }
  $ico = [System.Drawing.Icon]::FromHandle($h)
  $bmp = $ico.ToBitmap()
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose(); $ico.Dispose(); [RdShell]::DestroyIcon($h) | Out-Null
  return [Convert]::ToBase64String($ms.ToArray())
}

$out = @{}
foreach ($req in ($env:RD_ICONS | ConvertFrom-Json)) {
  $i = [RdShell]::Index($req.path, [bool]$req.attr, [bool]$req.dir)
  # SHIL_LARGE(0) = 32px, SHIL_EXTRALARGE(2) = 48px
  $out[$req.key] = @{ s = (ToPng ([RdShell]::Icon(0, $i))); l = (ToPng ([RdShell]::Icon(2, $i))) }
}
$out | ConvertTo-Json -Compress
