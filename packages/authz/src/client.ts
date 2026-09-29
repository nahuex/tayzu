import { GRPC } from '@cerbos/grpc';

/** Options for {@link createCerbosClient}. The address is always explicit. */
export interface CerbosClientOptions {
  /** `host:port` of the Cerbos gRPC endpoint, supplied by the host. */
  readonly address: string;
  /**
   * `false` only for the loopback sidecar link (Resolved decision Q8) and the
   * local/CI test container; TLS stays mandatory for every other link.
   */
  readonly tls: boolean;
}

/** The Cerbos gRPC client (`CheckResources`, `PlanResources`, ...). */
export type CerbosClient = GRPC;

/** Creates a Cerbos gRPC client for an explicitly supplied address. */
export function createCerbosClient(options: CerbosClientOptions): CerbosClient {
  return new GRPC(options.address, { tls: options.tls });
}
