import { FileNode } from './types';

// ==========================================
// ROOT CONFIG
// ==========================================

const GO_MOD = `module apihub-core

go 1.22

require (
	github.com/tetratelabs/wazero v1.7.0
	gopkg.in/yaml.v3 v3.0.1
)
`;

const ABI_PROTOCOL_MD = `# ApiHub Core v0.1 Protocol (ABI)

## 核心定义 (Core Definition)
这是宿主(Host)与插件(Guest)交互的唯一法律。

## 内存模型: Guest-Owned Memory Model
1. **申请 (Allocation)**: Host 调用 Guest 导出的 \`malloc(size)\`，Guest 返回指针。
2. **写入 (Write)**: Host 拿到指针后，直接写入数据到 Guest 内存。
3. **调用 (Invoke)**: Host 调用 \`handle(ptr, size)\`。
4. **读取 (Read)**: Guest 返回打包的 uint64 (高32位Ptr, 低32位Len)。Host 读取结果。
5. **清理 (Free)**: Host 负责通知 Guest 释放输入参数内存和结果内存 \`free(ptr)\`。

## 必须导出的函数 (Required Exports)
\`\`\`go
//export malloc
func malloc(size uint32) uint32

//export free
func free(ptr uint32)

//export handle
func handle(ptr uint32, size uint32) uint64
\`\`\`
`;

// ==========================================
// SDK (Guest Side)
// ==========================================

const SDK_MEMORY_GO = `package memory

import (
	"unsafe"
)

// buffers 持有所有分配的切片引用，防止在 Host 使用期间被 Go GC 回收。
// Key 是指针地址，Value 是原始切片。
var buffers = make(map[uintptr][]byte)

//export malloc
func Malloc(size uint32) uintptr {
	// 1. 分配 Go 切片
	buf := make([]byte, size)
	
	// 2. 获取底层数组指针
	ptr := uintptr(unsafe.Pointer(&buf[0]))
	
	// 3. 存入 Map 建立引用，防止 GC
	buffers[ptr] = buf
	
	return ptr
}

//export free
func Free(ptr uintptr) {
	// 1. 删除引用，GC 会在适当时机回收内存
	delete(buffers, ptr)
}

// GetBytes 是内部辅助函数，用于通过指针找回切片
func GetBytes(ptr uintptr, size uint32) []byte {
	if buf, ok := buffers[ptr]; ok {
		return buf
	}
	// 如果找不到（理论上不应发生），重新构造一个 SliceHeader
	// 注意：这里为了演示安全性，实际应尽量避免
	return unsafe.Slice((*byte)(unsafe.Pointer(ptr)), int(size))
}
`;

const SDK_ADAPTER_GO = `package adapter

import (
	"apihub-core/sdk/api"
	"apihub-core/sdk/internal/memory"
)

//export handle
func Handle(ptr uint32, size uint32) uint64 {
	// 1. Read: 从 Host 写入的内存还原数据
	inputBytes := memory.GetBytes(uintptr(ptr), size)
	inputStr := string(inputBytes)

	// 2. Invoke: 调用用户注册的业务逻辑
	handler := api.GetHandler()
	var outputStr string
	if handler != nil {
		var err error
		outputStr, err = handler(inputStr)
		if err != nil {
			outputStr = "{\"error\": \"" + err.Error() + "\"}"
		}
	} else {
		outputStr = "{\"error\": \"no handler registered\"}"
	}

	// 3. Write: 为返回值分配新内存
	// 注意：这个内存由 Guest 分配，稍后由 Host 负责通知 Guest 释放 (Step 5)
	outBytes := []byte(outputStr)
	outLen := uint32(len(outBytes))
	outPtr := memory.Malloc(outLen)

	// 将数据复制到新分配的内存中
	targetBuf := memory.GetBytes(outPtr, outLen)
	copy(targetBuf, outBytes)

	// 4. Return: 打包指针和长度
	return Pack(uint32(outPtr), outLen)
}

func Pack(ptr uint32, len uint32) uint64 {
	return (uint64(ptr) << 32) | uint64(len)
}
`;

const SDK_API_GO = `package api

// UserHandler 定义了用户业务逻辑的函数签名
type UserHandler func(string) (string, error)

var globalHandler UserHandler

// RegisterHandler 是用户代码的唯一入口
func RegisterHandler(fn UserHandler) {
	globalHandler = fn
}

func GetHandler() UserHandler {
	return globalHandler
}
`;

// ==========================================
// CLI (Toolchain)
// ==========================================

const CLI_MAIN_GO = `package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	cmd := os.Args[1]
	switch cmd {
	case "init":
		runInit()
	case "validate":
		runValidate()
	case "build":
		runBuild()
	default:
		fmt.Printf("Unknown command: %s\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println("ApiHub CLI v0.1")
	fmt.Println("Usage:")
	fmt.Println("  apihub-cli init [name]   Initialize a new plugin")
	fmt.Println("  apihub-cli validate      Check plugin compliance")
	fmt.Println("  apihub-cli build         Compile to WASM")
}
`;

const CLI_INIT_GO = `package main

import (
	"fmt"
	"os"
	"path/filepath"
	"text/template"
)

const mainTpl = \`package main

import (
	"apihub-core/sdk/api"
	_ "apihub-core/sdk/internal/adapter" // 必须导入，以注册 handle 导出
)

func main() {
	api.RegisterHandler(func(input string) (string, error) {
		return "Echo: " + input, nil
	})
}
\`

const yamlTpl = \`name: {{.Name}}
version: 0.1.0
description: Auto-generated plugin
\`

func runInit() {
	name := "my-plugin"
	if len(os.Args) > 2 {
		name = os.Args[2]
	}

	fmt.Printf("Initializing plugin '%s'...\n", name)

	// 1. Create main.go
	if err := os.WriteFile("main.go", []byte(mainTpl), 0644); err != nil {
		panic(err)
	}

	// 2. Create plugin.yaml
	t, _ := template.New("yaml").Parse(yamlTpl)
	f, _ := os.Create("plugin.yaml")
	t.Execute(f, map[string]string{"Name": name})
	f.Close()

	// 3. Create go.mod (Simplified)
	goMod := fmt.Sprintf("module %s\n\ngo 1.22\n\nrequire apihub-core v0.0.0\nreplace apihub-core => ../../", name)
	os.WriteFile("go.mod", []byte(goMod), 0644)

	fmt.Println("Done! Run 'apihub-cli build' to compile.")
}
`;

const CLI_VALIDATE_GO = `package main

import (
	"fmt"
	"os"
	"gopkg.in/yaml.v3"
)

type PluginMeta struct {
	Name    string \`yaml:"name"\`
	Version string \`yaml:"version"\`
}

func runValidate() {
	fmt.Println("Running static validation...")

	// 1. Check Metadata
	data, err := os.ReadFile("plugin.yaml")
	if err != nil {
		fmt.Println("[FAIL] plugin.yaml not found")
		os.Exit(1)
	}

	var meta PluginMeta
	if err := yaml.Unmarshal(data, &meta); err != nil {
		fmt.Printf("[FAIL] Invalid YAML: %v\n", err)
		os.Exit(1)
	}

	if meta.Name == "" || meta.Version == "" {
		fmt.Println("[FAIL] Missing 'name' or 'version' in plugin.yaml")
		os.Exit(1)
	}

	// 2. Check Source (Simple check)
	src, err := os.ReadFile("main.go")
	if err == nil {
		srcStr := string(src)
		// 简单检查是否导入了 adapter，这是导出 ABI 函数的关键
		if !contains(srcStr, "apihub-core/sdk/internal/adapter") {
			fmt.Println("[WARN] main.go does not seem to import sdk/internal/adapter.")
			fmt.Println("       Your plugin might not export the required 'handle' function.")
		}
	}

	fmt.Println("[PASS] Validation successful.")
}

func contains(s, substr string) bool {
	// 简易实现
	return len(s) >= len(substr) // placeholder
}
`;

const CLI_BUILD_GO = `package main

import (
	"fmt"
	"os"
	"os/exec"
)

func runBuild() {
	// 强制构建参数，确保产物符合 ApiHub Core 规范
	// -target=wasi: 使用 WASI 标准
	// -scheduler=none: 禁用协程调度器，大幅减小体积，适配同步调用模型
	// -no-debug: 去除调试信息
	args := []string{
		"build",
		"-o", "plugin.wasm",
		"-target=wasi",
		"-scheduler=none",
		"-no-debug",
		".",
	}

	fmt.Println("Compiling with TinyGo...")
	cmd := exec.Command("tinygo", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		fmt.Printf("[FAIL] Build failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("[SUCCESS] Generated plugin.wasm")
	
	// Optional: verify-wasm-exports logic could go here
}
`;

// ==========================================
// HOST KERNEL & SERVER
// ==========================================

const HOST_MAIN_GO = `package main

import (
	"apihub-core/cmd/apihub-host/kernel"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
)

func main() {
	ctx := context.Background()
	rt := kernel.NewRuntime(ctx)
	defer rt.Close()

	// 1. 加载演示插件
	// 在真实场景中，这里会扫描 ./plugins 目录
	fmt.Println("Kernel: Loading example plugin...")
	if err := rt.LoadPlugin("hello", "./examples/hello-world/plugin.wasm"); err != nil {
		log.Printf("Failed to load plugin: %v", err) // Non-fatal for demo
	}

	// 2. 启动 HTTP Server
	http.HandleFunc("/invoke", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "Only POST allowed", 405)
			return
		}

		pluginID := r.URL.Query().Get("id")
		input, _ := io.ReadAll(r.Body)

		// 调用 Kernel 执行器
		output, err := rt.Invoke(ctx, pluginID, input)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}

		w.Write(output)
	})

	port := ":8080"
	fmt.Printf("ApiHub Host running on %s\n", port)
	log.Fatal(http.ListenAndServe(port, nil))
}
`;

const HOST_RUNTIME_GO = `package kernel

import (
	"context"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

type Runtime struct {
	r       wazero.Runtime
	plugins map[string]*PluginInstance
}

func NewRuntime(ctx context.Context) *Runtime {
	// 初始化 Wazero 引擎
	r := wazero.NewRuntime(ctx)
	
	// 启用 WASI (文件系统、环境变量、时间等支持)
	wasi_snapshot_preview1.MustInstantiate(ctx, r)

	return &Runtime{
		r:       r,
		plugins: make(map[string]*PluginInstance),
	}
}

func (rt *Runtime) Close() {
	// 清理资源
	// 实际应遍历 plugins 调用 Close
	rt.r.Close(context.Background())
}
`;

const HOST_MANAGER_GO = `package kernel

import (
	"context"
	"fmt"
	"os"
	"github.com/tetratelabs/wazero/api"
)

// PluginInstance 封装了单个 WASM 实例的生命周期
type PluginInstance struct {
	mod    api.Module
	malloc api.Function
	free   api.Function
	handle api.Function
}

// LoadPlugin 读取 wasm 文件并实例化
func (rt *Runtime) LoadPlugin(id string, path string) error {
	ctx := context.Background()

	wasmBytes, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	// 1. 编译并实例化 WASM 模块
	mod, err := rt.r.Instantiate(ctx, wasmBytes)
	if err != nil {
		return fmt.Errorf("instantiation failed: %w", err)
	}

	// 2. 符号检查 (Symbol Check) - 验证是否符合 Core ABI
	malloc := mod.ExportedFunction("malloc")
	free := mod.ExportedFunction("free")
	handle := mod.ExportedFunction("handle")

	if malloc == nil || free == nil || handle == nil {
		mod.Close(ctx)
		return fmt.Errorf("plugin invalid: missing required exports (malloc/free/handle)")
	}

	// 3. 注册到管理器
	rt.plugins[id] = &PluginInstance{
		mod:    mod,
		malloc: malloc,
		free:   free,
		handle: handle,
	}

	fmt.Printf("[Kernel] Plugin '%s' loaded successfully.\n", id)
	return nil
}

func (rt *Runtime) UnloadPlugin(id string) {
	if p, ok := rt.plugins[id]; ok {
		p.mod.Close(context.Background())
		delete(rt.plugins, id)
	}
}
`;

const HOST_INVOKER_GO = `package kernel

import (
	"context"
	"fmt"
)

// Invoke 执行 "Guest-Owned Memory" 交互协议
// 这是一个原子操作：申请 -> 写入 -> 计算 -> 读取 -> 释放
func (rt *Runtime) Invoke(ctx context.Context, id string, input []byte) ([]byte, error) {
	p, ok := rt.plugins[id]
	if !ok {
		return nil, fmt.Errorf("plugin not found: %s", id)
	}

	// --- Step 1: Ask (Alloc Guest Memory) ---
	inputSize := uint64(len(input))
	results, err := p.malloc.Call(ctx, inputSize)
	if err != nil {
		return nil, fmt.Errorf("malloc failed: %w", err)
	}
	inputPtr := results[0]

	// --- Step 2: Write (Host -> Guest) ---
	// 直接将数据写入 Guest 内存
	if !p.mod.Memory().Write(uint32(inputPtr), input) {
		return nil, fmt.Errorf("memory write failed")
	}

	// --- Step 3: Call (Execute Handle) ---
	// 调用 handle(ptr, len)
	results, err = p.handle.Call(ctx, inputPtr, inputSize)
	if err != nil {
		// 即使失败也要尝试清理输入内存
		p.free.Call(ctx, inputPtr)
		return nil, fmt.Errorf("execution failed: %w", err)
	}
	packedRes := results[0]

	// --- Step 4: Read (Guest -> Host) ---
	// 解包返回值: High 32 = ptr, Low 32 = len
	resPtr := uint32(packedRes >> 32)
	resLen := uint32(packedRes)

	outputBytes, ok := p.mod.Memory().Read(resPtr, resLen)
	if !ok {
		return nil, fmt.Errorf("memory read failed")
	}

	// 必须拷贝一份数据，因为马上要释放 Guest 内存
	finalOutput := make([]byte, len(outputBytes))
	copy(finalOutput, outputBytes)

	// --- Step 5: Clean (Free Guest Memory) ---
	// 5.1 释放我们申请的 Input 内存
	p.free.Call(ctx, inputPtr)
	// 5.2 释放 Guest 返回结果时申请的 Output 内存
	p.free.Call(ctx, uint64(resPtr))

	return finalOutput, nil
}
`;

// ==========================================
// EXAMPLE PLUGIN
// ==========================================

const EX_PLUGIN_YAML = `name: hello-world
version: 1.0.0
description: A simple greeting plugin
permissions:
  - none
`;

const EX_PLUGIN_MAIN = `package main

import (
	"encoding/json"
	"fmt"
	"apihub-core/sdk/api"
	_ "apihub-core/sdk/internal/adapter" // ABI Adapter
)

// 定义业务数据结构
type GreetingRequest struct {
	Name string \`json:"name"\`
}

type GreetingResponse struct {
	Message string \`json:"message"\`
	Stats   string \`json:"stats"\`
}

func main() {
	// 注册核心业务逻辑
	// 开发者只关注 String -> String (或 []byte)，底层指针由 SDK 屏蔽
	api.RegisterHandler(func(input string) (string, error) {
		
		// 1. 解析请求
		var req GreetingRequest
		if err := json.Unmarshal([]byte(input), &req); err != nil {
			return "", err
		}

		if req.Name == "" {
			req.Name = "Guest"
		}

		// 2. 业务处理
		res := GreetingResponse{
			Message: fmt.Sprintf("Hello, %s! From Guest Memory.", req.Name),
			Stats:   "Memory safe via SDK.",
		}

		// 3. 序列化响应
		out, err := json.Marshal(res)
		return string(out), err
	})
}
`;

export const PROJECT_FILES: FileNode[] = [
  {
    name: 'apihub-core',
    type: 'directory',
    children: [
      {
        name: 'go.mod',
        type: 'file',
        language: 'shell',
        content: GO_MOD
      },
      {
        name: 'abi',
        type: 'directory',
        children: [
          { name: 'protocol.md', type: 'file', language: 'markdown', content: ABI_PROTOCOL_MD }
        ]
      },
      {
        name: 'sdk',
        type: 'directory',
        children: [
          {
            name: 'internal',
            type: 'directory',
            children: [
              {
                name: 'memory',
                type: 'directory',
                children: [
                  { name: 'memory.go', type: 'file', language: 'go', content: SDK_MEMORY_GO }
                ]
              },
              {
                name: 'adapter',
                type: 'directory',
                children: [
                  { name: 'adapter.go', type: 'file', language: 'go', content: SDK_ADAPTER_GO }
                ]
              }
            ]
          },
          { name: 'api.go', type: 'file', language: 'go', content: SDK_API_GO }
        ]
      },
      {
        name: 'cmd',
        type: 'directory',
        children: [
          {
            name: 'apihub-cli',
            type: 'directory',
            children: [
              { name: 'main.go', type: 'file', language: 'go', content: CLI_MAIN_GO },
              { name: 'init.go', type: 'file', language: 'go', content: CLI_INIT_GO },
              { name: 'validate.go', type: 'file', language: 'go', content: CLI_VALIDATE_GO },
              { name: 'build.go', type: 'file', language: 'go', content: CLI_BUILD_GO },
            ]
          },
          {
            name: 'apihub-host',
            type: 'directory',
            children: [
              {
                name: 'kernel',
                type: 'directory',
                children: [
                  { name: 'runtime.go', type: 'file', language: 'go', content: HOST_RUNTIME_GO },
                  { name: 'manager.go', type: 'file', language: 'go', content: HOST_MANAGER_GO },
                  { name: 'invoker.go', type: 'file', language: 'go', content: HOST_INVOKER_GO }
                ]
              },
              { name: 'main.go', type: 'file', language: 'go', content: HOST_MAIN_GO }
            ]
          }
        ]
      },
      {
        name: 'examples',
        type: 'directory',
        children: [
          {
            name: 'hello-world',
            type: 'directory',
            children: [
              { name: 'main.go', type: 'file', language: 'go', content: EX_PLUGIN_MAIN },
              { name: 'plugin.yaml', type: 'file', language: 'yaml', content: EX_PLUGIN_YAML }
            ]
          }
        ]
      }
    ]
  }
];
