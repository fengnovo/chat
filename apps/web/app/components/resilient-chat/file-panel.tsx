import { useMemo, useState } from 'react';

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

function FilePanel({
  files,
  onClose,
}: {
  files: TouchedFile[];
  onClose: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const tree = useMemo(() => buildFileTree(files), [files]);
  const selected = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? files[0] ?? null,
    [files, selectedPath],
  );

  return (
    <aside className="file-panel" aria-label="AI 生成的文件">
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
          <Icon name="x" size={17} />
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

export { FilePanel, type TouchedFile };
