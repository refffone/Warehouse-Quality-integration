<#
.SYNOPSIS
  Copies the TDS / MSDS / Photo files embedded in the Access inspection log
  (RM Master Data) into a folder, with a manifest the upload script reads.

.DESCRIPTION
  Opens the database read-only through Access's own DAO engine (Microsoft
  Access must be installed) and never changes it. Work on a copy if the
  database is in use. Output:

    <OutDir>\<AccessID>\<kind>\<file name>
    <OutDir>\manifest.csv   access_id, legacy_ref, kind, file_name, bytes, path, note

  Re-running skips files that already exist.

.EXAMPLE
  .\scripts\extract-access-attachments.ps1 -Database "C:\data\RM TEST.accdb" -OutDir "C:\Users\me\access-attachments"
#>
param(
  [Parameter(Mandatory = $true)] [string] $Database,
  [Parameter(Mandatory = $true)] [string] $OutDir
)
$ErrorActionPreference = "Stop"

$kinds = @{ TDS = "tds"; MSDS = "msds"; Photo = "photo" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$manifest = New-Object System.Collections.Generic.List[object]

$access = New-Object -ComObject Access.Application
try {
  $db = $access.DBEngine.OpenDatabase($Database, $false, $true)
  $rs = $db.OpenRecordset("SELECT ID, TDS, MSDS, Photo FROM [RM Master Data] ORDER BY ID")
  while (-not $rs.EOF) {
    $id = $rs.Fields("ID").Value
    foreach ($field in $kinds.Keys) {
      $files = $rs.Fields($field).Value
      while (-not $files.EOF) {
        $name = "$($files.Fields('FileName').Value)"
        # keep the original name, minus characters Windows can't store
        $safe = ($name -replace '[\\/:*?"<>|]', '_').Trim()
        $dir = Join-Path $OutDir (Join-Path $id $kinds[$field])
        New-Item -ItemType Directory -Force $dir | Out-Null
        $path = Join-Path $dir $safe
        if (-not (Test-Path -LiteralPath $path)) { $files.Fields("FileData").SaveToFile($path) }
        $ext = [IO.Path]::GetExtension($safe).ToLower()
        $stream = [IO.File]::OpenRead($path)
        try { $buf = New-Object byte[] 4; [void]$stream.Read($buf, 0, 4) } finally { $stream.Dispose() }
        $head = [Text.Encoding]::ASCII.GetString($buf)
        $note = if ($ext -notin ".pdf", ".jpg", ".jpeg", ".png") {
                  if ($head -eq "%PDF") { "a PDF with a wrong or missing extension - uploaded as .pdf" }
                  else { "unrecognised file type ($ext)" }
                } else { "" }
        $manifest.Add([pscustomobject]@{
          access_id  = $id
          legacy_ref = "access:RM Master Data:$id"
          kind       = $kinds[$field]
          file_name  = $safe
          bytes      = (Get-Item -LiteralPath $path).Length
          path       = $path
          note       = $note
        })
        $files.MoveNext()
      }
      $files.Close()
    }
    $rs.MoveNext()
  }
  $db.Close()
}
finally {
  $access.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($access)
}

$manifest | Export-Csv (Join-Path $OutDir "manifest.csv") -NoTypeInformation -Encoding utf8
$mb = [math]::Round((($manifest | Measure-Object bytes -Sum).Sum) / 1MB, 1)
"Extracted $($manifest.Count) files ($mb MB) to $OutDir"
"Flagged: $(@($manifest | Where-Object note).Count) (see the 'note' column in manifest.csv)"
