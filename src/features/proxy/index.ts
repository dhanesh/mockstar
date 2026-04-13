// Barrel re-export for the proxy subsystem.
export { caFacts, resolveCaPaths, installCa, uninstallCa, enforceKeyPermissions, nodeExtraCaCertsMessage, scopedCommonName, generateLeaf } from './ca.ts';
export { loadConfigFile, parseConfig, watchConfig, ProxyConfigSchema } from './config.ts';
export { SnapshotHolder, buildSnapshot, evictedHostnames, needsRefresh } from './cert-cache.ts';
export { sniGate, explainSni } from './sni-gate.ts';
export { forwardToMockstar, probeMockstarHealth } from './upstream.ts';
export { startTlsServer, bunVersion, snapshotResolver, listenParams, leavesFromSnapshot } from './tls-adapter.ts';
export type { TlsLeaf, TlsServerHandle, TlsServerOptions, RequestMeta } from './tls-adapter.ts';
export { startProxyServer, type ProxyRuntime, type StartOptions } from './server.ts';
export { detectEnvHostility, remediationMessage } from './env-detector.ts';
export { portBindMutation, isPlatformSupported, runPrivileged } from './port-bind.ts';
export { appendStep, readJournal, reverseSteps, clearJournal, journalFacts, atomicInstall, executeReverse, type Mutation } from './install-journal.ts';
export { buildDnsMutations, revertHostsBlock, stopAndRemoveDnsmasq, HOSTS_BLOCK_MARKER, HOSTS_BLOCK_END } from './dns.ts';
export type { ProxyConfig, HostConfig, LeafCert, ProxySnapshot, EnvHostility, InstallStep, ReverseCommand } from './types.ts';
export { ProxyError } from './types.ts';
