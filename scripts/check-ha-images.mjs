const [rawOwner, version] = process.argv.slice(2)
const owner = rawOwner?.toLowerCase()
if (!/^[a-z0-9-]+$/.test(owner ?? "") || !/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Expected registry owner and release version")
for (const arch of ["amd64", "aarch64"]) {
  const name = `${arch}-jep`
  const scope = encodeURIComponent(`repository:${owner}/${name}:pull`)
  const response = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${scope}`, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Cannot pull ${name} anonymously (${response.status}). Make the GHCR package public at https://github.com/orgs/${owner}/packages/container/${name}/settings`)
  const { token } = await response.json()
  const manifest = await fetch(`https://ghcr.io/v2/${owner}/${name}/manifests/${version}`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!manifest.ok) throw new Error(`Image ${owner}/${name}:${version} is unavailable (${manifest.status})`)
  console.log(`Public image ready: ghcr.io/${owner}/${name}:${version}`)
}
