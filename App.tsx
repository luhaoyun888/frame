import React, { useState, useEffect } from 'react';
import { PROJECT_FILES } from './constants';
import { FileTree } from './components/FileTree';
import { FileNode } from './types';
import { Box, Code2, Layout, Cpu, ArrowRight, FileText } from 'lucide-react';

const App: React.FC = () => {
  // Flatten file finding for initial state
  const findDefaultFile = (nodes: FileNode[]): FileNode | null => {
    for (const node of nodes) {
      if (node.name === 'protocol.md') return node;
      if (node.children) {
        const found = findDefaultFile(node.children);
        if (found) return found;
      }
    }
    return null;
  };

  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);

  // Set default file on mount
  useEffect(() => {
    const defaultFile = findDefaultFile(PROJECT_FILES[0].children || []);
    if (defaultFile) setSelectedFile(defaultFile);
  }, []);

  return (
    <div className="flex h-screen bg-slate-900 text-slate-200 font-sans overflow-hidden">
      {/* Sidebar */}
      <div className="w-80 flex-shrink-0 border-r border-slate-700 flex flex-col bg-slate-800">
        <div className="p-4 border-b border-slate-700 bg-slate-900">
          <h1 className="text-xl font-bold flex items-center gap-2 text-cyan-400">
            <Cpu size={24} />
            ApiHub Core
            <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full ml-auto">v0.1</span>
          </h1>
          <p className="text-xs text-slate-400 mt-2">基于“客人自理内存模型”的架构蓝图</p>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
           <FileTree 
              nodes={PROJECT_FILES} 
              onSelect={setSelectedFile} 
              selectedFile={selectedFile} 
           />
        </div>
        
        <div className="p-4 border-t border-slate-700 bg-slate-900 text-xs text-slate-500">
          <div className="flex items-center gap-2 mb-1">
            <Box size={14} /> <span>核心架构: MVU</span>
          </div>
          <div className="flex items-center gap-2">
            <Layout size={14} /> <span>开发语言: Go 1.22</span>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedFile ? (
          <>
            {/* Tab Header */}
            <div className="flex items-center h-10 bg-slate-900 border-b border-slate-700 px-4">
               <div className="flex items-center gap-2 text-sm px-4 py-2 bg-slate-800 border-t-2 border-cyan-500 text-slate-200">
                 {selectedFile.name.endsWith('.go') ? <Code2 size={14} className="text-cyan-400"/> : <FileText size={14} />}
                 {selectedFile.name}
               </div>
            </div>

            {/* Code View */}
            <div className="flex-1 overflow-auto bg-slate-900 p-6">
              <div className="max-w-4xl mx-auto">
                 {/* Breadcrumbs */}
                 <div className="flex items-center text-xs text-slate-500 mb-4 font-mono">
                    <span>apihub-core</span>
                    <ArrowRight size={10} className="mx-2"/>
                    <span className="text-cyan-400">{selectedFile.name}</span>
                 </div>

                 <div className="bg-slate-950 rounded-lg border border-slate-800 shadow-xl overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-800">
                       <span className="text-xs font-mono text-slate-400 uppercase">{selectedFile.language}</span>
                       <div className="flex gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full bg-red-500/20"></div>
                          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/20"></div>
                          <div className="w-2.5 h-2.5 rounded-full bg-green-500/20"></div>
                       </div>
                    </div>
                    <div className="p-4 overflow-x-auto">
                      <pre className="font-mono text-sm leading-relaxed text-slate-300">
                        <code>{selectedFile.content}</code>
                      </pre>
                    </div>
                 </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-500">
            请选择一个文件以查看具体实现
          </div>
        )}
      </div>
    </div>
  );
};

export default App;