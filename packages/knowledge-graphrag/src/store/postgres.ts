export interface PostgresStore { replaceDocumentGraph(tenantId: string, kbId: string, documentId: string, graph: any): Promise<void> }

export class PostgresGraphStore implements PostgresStore {
  constructor(private readonly repository: any) {}
  replaceDocumentGraph(tenantId: string, kbId: string, documentId: string, graph: any) {
    return this.repository.replaceDocumentGraph(tenantId, kbId, documentId, graph);
  }
}

