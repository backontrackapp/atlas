export interface ManifestNode {
  id: string
  title: string
  path: string
  statePath: string
  screenshotPath: string
  width: number
  height: number
  capturedAt?: string | null
  screenshotUpdatedAt?: string | null
  captureVersion?: string | null
  status?: string
}

export interface ManifestEdge {
  id: string
  source: string
  target: string
  labels: string[]
  kinds: string[]
}

export interface WorkflowManifest {
  generatedAt: string
  capturedAt?: string
  appRoot: string
  capture: {
    width: number
    height: number
  }
  routes: unknown[]
  transitions: unknown[]
  nodes: ManifestNode[]
  edges: ManifestEdge[]
}
