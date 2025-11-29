export interface FileNode {
  name: string;
  type: 'file' | 'directory';
  content?: string;
  children?: FileNode[];
  language?: 'go' | 'yaml' | 'markdown' | 'shell';
}

export interface FileSystem {
  root: FileNode[];
}