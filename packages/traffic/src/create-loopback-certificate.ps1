param([Parameter(Mandatory)][string]$KeyPath, [Parameter(Mandatory)][string]$CertPath)
$ErrorActionPreference = 'Stop'
$rsa = [Security.Cryptography.RSA]::Create(2048)
try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=127.0.0.1', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddIpAddress([Net.IPAddress]::Loopback)
    $san.AddDnsName('localhost')
    $request.CertificateExtensions.Add($san.Build())
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $usage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage, $true))
    $oids = [Security.Cryptography.OidCollection]::new()
    [void]$oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false))
    $now = [DateTimeOffset]::UtcNow
    $cert = $request.CreateSelfSigned($now, $now.AddDays(365))
    try {
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        [IO.File]::WriteAllText($KeyPath, $rsa.ExportPkcs8PrivateKeyPem(), $utf8)
        [IO.File]::WriteAllText($CertPath, $cert.ExportCertificatePem(), $utf8)
    } finally { $cert.Dispose() }
} finally { $rsa.Dispose() }
