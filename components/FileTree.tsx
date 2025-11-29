import React, { useState } from 'react';
import { Folder, FolderOpen, FileCode, FileText, ChevronRight, ChevronDown, Terminal } from 'lucide-react';
import { FileNode } from '../types';

interface FileTreeProps {
  nodes: FileNode[];
  onSelect: (node: FileNode) => void;
  selectedFile: FileNode | null;
  level?: number;
}

const getIcon = (name: string, type: 'file' | 'directory', isOpen: boolean) => {
  if (type === 'directory') {
    return isOpen ? <FolderOpen size={16} className="text-blue-400" /> : <Folder size={16} className="text-blue-400" />;
  }
  if (name.endsWith('.go')) return <FileCode size={16} className="text-cyan-400" />;
  if (name.endsWith('.md')) return <FileText size={16} className="text-gray-400" />;
  if (name.endsWith('.yaml')) return <FileText size={16} className="text-yellow-400" />;
  return <Terminal size={16} className="text-gray-500" />;
};

export const FileTree: React.FC<FileTreeProps> = ({ nodes, onSelect, selectedFile, level = 0 }) => {
  return (
    <div className="text-sm font-mono">
      {nodes.map((node, index) => (
        <FileTreeNode
          key={index}
          node={node}
          onSelect={onSelect}
          selectedFile={selectedFile}
          level={level}
        />
      ))}
    </div>
  );
};

const FileTreeNode: React.FC<{
  node: FileNode;
  onSelect: (node: FileNode) => void;
  selectedFile: FileNode | null;
  level: number;
}> = ({ node, onSelect, selectedFile, level }) => {
  const [isOpen, setIsOpen] = useState(true);
  const isSelected = selectedFile?.name === node.name && selectedFile?.content === node.content;

  const handleClick = () => {
    if (node.type === 'directory') {
      setIsOpen(!isOpen);
    } else {
      onSelect(node);
    }
  };

  return (
    <div>
      <div
        className={`flex items-center py-1 px-2 cursor-pointer hover:bg-slate-700 transition-colors ${
          isSelected ? 'bg-slate-700 border-l-2 border-cyan-400' : ''
        }`}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={handleClick}
      >
        <span className="mr-1.5 opacity-70">
           {node.type === 'directory' && (
             isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
           )}
           {node.type === 'file' && <span className="w-[14px] inline-block" />}
        </span>
        <span className="mr-2">{getIcon(node.name, node.type, isOpen)}</span>
        <span className={`${isSelected ? 'text-white font-medium' : 'text-slate-300'}`}>
          {node.name}
        </span>
      </div>
      {isOpen && node.children && (
        <FileTree
          nodes={node.children}
          onSelect={onSelect}
          selectedFile={selectedFile}
          level={level + 1}
        />
      )}
    </div>
  );
};