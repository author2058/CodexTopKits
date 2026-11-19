[CmdletBinding()]
param([string]$ETag)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$headers = @{ Accept = 'application/json' }
if ($ETag) { $headers['If-None-Match'] = $ETag }

try {
    $response = Invoke-WebRequest -Uri 'https://codex-resets.com/api/v1/status' -Headers $headers -SkipHttpErrorCheck
    $result = @{
        status = [int]$response.StatusCode
        headers = @{ ETag = [string]$response.Headers.ETag; 'Retry-After' = [string]$response.Headers.'Retry-After' }
        body = $utf8.GetString($response.RawContentStream.ToArray())
    }
}
catch [System.Net.Http.HttpRequestException], [System.Threading.Tasks.TaskCanceledException] {
    $result = @{ transportError = @{ name = $_.Exception.GetType().FullName; message = $_.Exception.Message; stack = $_.Exception.StackTrace } }
}
[Console]::WriteLine(($result | ConvertTo-Json -Depth 4 -Compress))
