import * as monaco from 'monaco-editor'
import { memoryIssueSeverity, type MemoryHealthReport } from '../../shared/memory-health'

/**
 * Surfaces memory health issues as Monaco markers on any model under a memory
 * dir — open now or created later (an editor loads the file after the report
 * arrived).
 */

const OWNER = 'memory-health'

const reports = new Map<string, MemoryHealthReport>()
let createHook: monaco.IDisposable | null = null

function isUnder(path: string, dir: string): boolean {
  return path.startsWith(`${dir}/`)
}

function reportFor(path: string): MemoryHealthReport | undefined {
  for (const [dir, report] of reports) {
    if (isUnder(path, dir)) return report
  }
  return undefined
}

function markersFor(report: MemoryHealthReport, model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  const uri = model.uri.toString()
  return report.issues
    .filter((issue) => monaco.Uri.file(issue.file).toString() === uri)
    .map((issue) => ({
      startLineNumber: issue.line,
      startColumn: issue.column,
      endLineNumber: issue.line,
      endColumn: issue.endColumn,
      message: issue.message,
      severity:
        memoryIssueSeverity(issue.kind) === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
      source: 'memory',
    }))
}

function apply(model: monaco.editor.ITextModel): void {
  if (model.uri.scheme !== 'file') return
  const report = reportFor(model.uri.fsPath)
  if (report) monaco.editor.setModelMarkers(model, OWNER, markersFor(report, model))
}

export function setMemoryReport(report: MemoryHealthReport): void {
  reports.set(report.memoryDir, report)
  createHook ??= monaco.editor.onDidCreateModel(apply)
  for (const model of monaco.editor.getModels()) apply(model)
}

export function clearMemoryMarkers(memoryDir: string): void {
  reports.delete(memoryDir)
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme === 'file' && isUnder(model.uri.fsPath, memoryDir)) {
      monaco.editor.setModelMarkers(model, OWNER, [])
    }
  }
  if (reports.size === 0) {
    createHook?.dispose()
    createHook = null
  }
}
