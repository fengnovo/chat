import { type PointerEvent, useMemo, useRef, useState } from 'react';

import { Icon } from './icon';

type TouchedFile = {
  path: string;
  /** 最近一次可展示的内容来源：write_file/edit_file 的 input.content，或 read_file 的 output。 */
  content: string | null;
  /** 最后一次操作类型，用于区分新建/修改/读取。 */
  operation: 'write_file' | 'edit_file' | 'read_file' | 'delete';
};

type FileNode = {
  name: string;
  /** 相对当前节点的路径（如 src/components/foo.tsx）。 */
  path: string;
  isDir: boolean;
  children: FileNode[];
  file?: TouchedFile;
};

function buildFileTree(files: TouchedFile[]): FileNode[] {
  const root: FileNode = { name: '', path: '', isDir: true, children: [] };
  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean);
    let current = root;
    let acc = '';
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      acc = acc ? `${acc}/${segment}` : segment;
      const isLast = i === segments.length - 1;
      let node = current.children.find((child) => child.name === segment);
      if (!node) {
        node = {
          name: segment,
          path: acc,
          isDir: !isLast,
          children: [],
          file: isLast ? file : undefined,
        };
        current.children.push(node);
      } else if (isLast) {
        node.file = file;
      }
      current = node;
    }
  }
  return root.children;
}

function extOf(name: string) {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function languageFromPath(path: string) {
  const ext = extOf(path);
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    css: 'css',
    html: 'html',
    md: 'markdown',
    py: 'python',
    sh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
  };
  return map[ext] ?? 'plaintext';
}

function FileTree({
  nodes,
  selectedPath,
  onSelect,
}: {
  nodes: FileNode[];
  selectedPath: string | null;
  onSelect: (file: TouchedFile) => void;
}) {
  return (
    <ul className="file-tree">
      {nodes.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function FileTreeNode({
  depth,
  node,
  onSelect,
  selectedPath,
}: {
  depth: number;
  node: FileNode;
  onSelect: (file: TouchedFile) => void;
  selectedPath: string | null;
}) {
  const [open, setOpen] = useState(depth < 1);
  if (node.isDir) {
    return (
      <li>
        <button
          aria-expanded={open}
          className="file-dir"
          style={{ paddingLeft: 10 + depth * 14 }}
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          <Icon name="chevron" size={14} />
          <Icon name="folder" size={15} />
          <span>{node.name}</span>
        </button>
        {open && (
          <ul>
            {node.children.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }
  const selected = node.path === selectedPath;
  return (
    <li>
      <button
        className={`file-item ${selected ? 'is-selected' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 + 18 }}
        type="button"
        onClick={() => node.file && onSelect(node.file)}
      >
        <Icon name="edit" size={14} />
        <span className="file-item-name">{node.name}</span>
        <span className={`file-op file-op-${node.file?.operation ?? 'read_file'}`}>
          {node.file?.operation === 'write_file'
            ? '新建'
            : node.file?.operation === 'edit_file'
              ? '修改'
              : node.file?.operation === 'delete'
                ? '删除'
                : '读取'}
        </span>
      </button>
    </li>
  );
}

function FilePreview({ file }: { file: TouchedFile }) {
  const lang = languageFromPath(file.path);
  if (file.content === null) {
    return (
      <div className="file-preview-empty">
        <Icon name="folder" size={28} />
        <p>{file.path}</p>
        <small>该文件没有可预览的内容（仅记录了路径操作）。</small>
      </div>
    );
  }
  return (
    <div className="file-preview">
      <div className="file-preview-head">
        <span className="file-preview-path">{file.path}</span>
        <span className="file-preview-lang">{lang}</span>
      </div>
      <pre className="file-preview-code">
        <code>{file.content}</code>
      </pre>
    </div>
  );
}

const MIN_FILES_WIDTH = 320;
const MAX_FILES_WIDTH = 680;
const MIN_CHAT_WIDTH = 360;
const DEFAULT_FILES_WIDTH = 420;

/** 文件面板左边缘的拖拽条：左右拖动改变整个文件面板的宽度。 */
function PanelResizer({
  onResize,
  onDoubleClick,
}: {
  onResize: (width: number) => void;
  onDoubleClick: () => void;
}) {
  const dragRef = useRef<{ x: number; width: number; max: number } | null>(null);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const panel = event.currentTarget.closest(
      '.file-panel',
    ) as HTMLElement | null;
    const currentWidth = panel?.offsetWidth ?? DEFAULT_FILES_WIDTH;
    const max = Math.min(
      MAX_FILES_WIDTH,
      window.innerWidth - MIN_CHAT_WIDTH,
    );
    dragRef.current = {
      x: event.clientX,
      width: currentWidth,
      max,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('is-file-resizing');
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    // 鼠标向左拖 -> 面板变宽
    const next = Math.min(
      drag.max,
      Math.max(MIN_FILES_WIDTH, drag.width + drag.x - event.clientX),
    );
    onResize(next);
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    document.body.classList.remove('is-file-resizing');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      aria-label="拖动调整文件面板宽度"
      aria-orientation="vertical"
      className="file-panel-resizer"
      role="separator"
      onDoubleClick={onDoubleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}

function FilePanel({
  files,
  onClose,
  onResize,
  onResetWidth,
}: {
  files: TouchedFile[];
  onClose: () => void;
  onResize: (width: number) => void;
  onResetWidth: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const tree = useMemo(() => buildFileTree(files), [files]);
  const selected = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? files[0] ?? null,
    [files, selectedPath],
  );

  return (
    <aside className="file-panel" aria-label="AI 生成的文件">
      <PanelResizer onResize={onResize} onDoubleClick={onResetWidth} />
      <header className="file-panel-head">
        <div className="file-panel-title">
          <Icon name="folder" size={17} />
          <strong>文件</strong>
          <span className="file-panel-count">{files.length}</span>
        </div>
        <button
          aria-label="关闭文件面板"
          className="icon-button"
          type="button"
          onClick={onClose}
        >
          <Icon name="x" size={16} />
        </button>
      </header>

      {files.length === 0 ? (
        <div className="file-panel-empty">
          <Icon name="folder" size={30} />
          <p>还没有生成的文件</p>
          <small>AI 写入或修改文件后会出现在这里。</small>
        </div>
      ) : (
        <div className="file-panel-body">
          <div className="file-tree-pane">
            <FileTree
              nodes={tree}
              selectedPath={selected?.path ?? null}
              onSelect={(file) => setSelectedPath(file.path)}
            />
          </div>
          <div className="file-preview-pane">
            {selected ? (
              <FilePreview file={selected} />
            ) : (
              <div className="file-preview-empty">
                <Icon name="folder" size={28} />
                <p>选择左侧文件查看内容</p>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

export {
  DEFAULT_FILES_WIDTH,
  FilePanel,
  type TouchedFile,
};
