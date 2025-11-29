import { FileNode } from './types';

const SDK_MEMORY_GO = `package memory

import (
	"unsafe"
)

// Global map to hold references to allocated slices to prevent GC
// In a real Guest-Owned model, we might use a bump allocator or rely on
// TinyGo's gc, but we need to ensure the pointer remains valid during the host call.
var buffers = make(map[uintptr][]byte)

//export malloc
func Malloc(size uint32) uintptr {
	// 1. Allocate a Go slice
	buf := make([]byte, size)
	
	// 2. Get the pointer to the underlying array
	ptr := uintptr(unsafe.Pointer(&buf[0]))
	
	// 3. Keep a reference so GC doesn't sweep it while Host is using it
	buffers[ptr] = buf
	
	return ptr
}

//export free
func Free(ptr uintptr) {
	// 1. Remove reference, allowing GC to eventually collect it
	delete(buffers, ptr)
}

// Helper for the Adapter to read memory
func GetBytes(ptr uintptr, size uint32) []byte {
    // In TinyGo/WASM, we can reconstruct the slice
    return buffers[ptr]
}
`;

const SDK_ADAPTER_GO = `package adapter

import (
	"encoding/binary"
	"unsafe"
	"apihub-core/sdk/internal/memory"
	"apihub-core/sdk/api"
)

//export handle
func Handle(ptr uint32, size uint32) (uint64) {
	// 1. Read Input from Host
	// We reconstruct the slice from the pointer provided by Host (which called our malloc)
	// Note: In a strict Guest-Owned model, the Host writes to the ptr we gave it.
	inputBytes := memory.GetBytes(uintptr(ptr), size)
	
	inputStr := string(inputBytes)

	// 2. Invoke User Logic
	// We assume the user registered a handler in api package
	handler := api.GetHandler()
	if handler == nil {
		return pack(0, 0) // Fail safe
	}

	outputStr, err := handler(inputStr)
	if err != nil {
		outputStr = "error: " + err.Error()
	}

	// 3. Write Output
	// We need to allocate memory for the response so the Host can read it
	outBytes := []byte(outputStr)
	outLen := uint32(len(outBytes))
	outPtr := memory.Malloc(outLen)
	
	// Copy data to the malloc'd area (memory.Malloc returns a pointer to a slice kept in map)
	// We need to get the actual slice to copy into
	targetBuf := memory.GetBytes(outPtr, outLen)
	copy(targetBuf, outBytes)

	// 4. Return Packed Pointer and Length
	// High 32 bits = ptr, Low 32 bits = len
	return pack(uint32(outPtr), outLen)
}

func pack(ptr uint32, len uint32) uint64 {
	return (uint64(ptr) << 32) | uint64(len)
}
`;

const SDK_API_GO = `package api

var globalHandler func(string) (string, error)

// RegisterHandler is the entry point for Plugin Developers
func RegisterHandler(fn func(string) (string, error)) {
	globalHandler = fn
}

func GetHandler() func(string) (string, error) {
	return globalHandler
}
`;

const CLI_MAIN_GO = `package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("Usage: apihub-cli <command> [args]")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "init":
		runInit()
	case "build":
		runBuild()
	default:
		fmt.Printf("Unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}
`;

const CLI_BUILD_GO = `package main

import (
	"fmt"
	"os"
	"os/exec"
)

func runBuild() {
	// Standard ApiHub compilation flags
	// -target=wasi: Target WebAssembly System Interface
	// -scheduler=none: Disables Goroutine scheduler for smaller binary size (sync execution only)
	// -no-debug: Strips debug info
	args := []string{
		"build",
		"-o", "plugin.wasm",
		"-target=wasi",
		"-scheduler=none",
		"-no-debug",
		".",
	}

	fmt.Println("Building plugin with TinyGo...")
	cmd := exec.Command("tinygo", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		fmt.Printf("Build failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Success! Generated plugin.wasm")
	// Optional: Validate exports here by parsing the WASM header
}
`;

const HOST_RUNTIME_GO = `package kernel

import (
	"context"
	"log"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

type Runtime struct {
	r       wazero.Runtime
	ctx     context.Context
	plugins map[string]*PluginInstance
}

func NewRuntime(ctx context.Context) *Runtime {
	r := wazero.NewRuntime(ctx)
	
	// Enable WASI (Filesystem, Args, Env, Time)
	wasi_snapshot_preview1.MustInstantiate(ctx, r)

	return &Runtime{
		r:       r,
		ctx:     ctx,
		plugins: make(map[string]*PluginInstance),
	}
}

func (rt *Runtime) Close() {
	rt.r.Close(rt.ctx)
}
`;

const HOST_INVOKER_GO = `package kernel

import (
	"context"
	"encoding/binary"
	"fmt"
	"github.com/tetratelabs/wazero/api"
)

type PluginInstance struct {
	mod    api.Module
	malloc api.Function
	free   api.Function
	handle api.Function
}

// Invoke executes the Guest-Owned Memory Protocol
// 1. Ask Guest to allocate memory for input
// 2. Write input to Guest memory
// 3. Call handle
// 4. Read output from Guest memory
// 5. Ask Guest to free memory
func (p *PluginInstance) Invoke(ctx context.Context, input []byte) ([]byte, error) {
	inputSize := uint64(len(input))

	// --- Step 1: Alloc (Guest Side) ---
	// Call export malloc(size)
	res, err := p.malloc.Call(ctx, inputSize)
	if err != nil {
		return nil, fmt.Errorf("malloc failed: %w", err)
	}
	inputPtr := res[0]

	// --- Step 2: Write (Host Side) ---
	// Write data directly to the pointer returned by Guest
	if !p.mod.Memory().Write(uint32(inputPtr), input) {
		return nil, fmt.Errorf("memory write failed out of bounds")
	}

	// --- Step 3: Handle (Guest Side) ---
	// Call export handle(ptr, len)
	// Returns a packed uint64 (ptr << 32 | len)
	res, err = p.handle.Call(ctx, inputPtr, inputSize)
	if err != nil {
		// Clean up input memory even on failure
		p.free.Call(ctx, inputPtr)
		return nil, fmt.Errorf("handle execution failed: %w", err)
	}
	packed := res[0]

	// --- Step 4: Unpack & Read (Host Side) ---
	resPtr := uint32(packed >> 32)
	resLen := uint32(packed)

	output, ok := p.mod.Memory().Read(resPtr, resLen)
	if !ok {
		return nil, fmt.Errorf("memory read failed out of bounds")
	}

	// Make a copy because we are about to free the guest memory
	finalOutput := make([]byte, len(output))
	copy(finalOutput, output)

	// --- Step 5: Clean (Guest Side) ---
	// Free Input Buffer
	p.free.Call(ctx, inputPtr)
	// Free Result Buffer (Guest allocated it for the response)
	p.free.Call(ctx, uint64(resPtr))

	return finalOutput, nil
}
`;

const HOST_LOADER_GO = `package kernel

import (
	"context"
	"fmt"
	"os"
)

func (rt *Runtime) LoadPlugin(id string, wasmPath string) error {
	wasmBytes, err := os.ReadFile(wasmPath)
	if err != nil {
		return err
	}

	// Compile & Instantiate
	mod, err := rt.r.Instantiate(rt.ctx, wasmBytes)
	if err != nil {
		return err
	}

	// Symbol Check (Protocol Validation)
	malloc := mod.ExportedFunction("malloc")
	free := mod.ExportedFunction("free")
	handle := mod.ExportedFunction("handle")

	if malloc == nil || free == nil || handle == nil {
		mod.Close(rt.ctx)
		return fmt.Errorf("plugin %s violates ABI: missing required exports", id)
	}

	rt.plugins[id] = &PluginInstance{
		mod:    mod,
		malloc: malloc,
		free:   free,
		handle: handle,
	}
	
	return nil
}
`;

const EXAMPLE_PLUGIN_GO = `package main

import (
	"fmt"
	"encoding/json"
	"apihub-core/sdk/api"
	_ "apihub-core/sdk/internal/adapter" // Essential: Registers the ABI exports
)

type Request struct {
	Name string "json:\"name\""
}

type Response struct {
	Message string "json:\"message\""
}

func main() {
	// User Logic: Pure Go, no pointers, no WASM specific code visible here
	api.RegisterHandler(func(input string) (string, error) {
		var req Request
		if err := json.Unmarshal([]byte(input), &req); err != nil {
			return "", err
		}

		res := Response{
			Message: fmt.Sprintf("Hello, %s! Welcome to ApiHub.", req.Name),
		}

		out, _ := json.Marshal(res)
		return string(out), nil
	})
}
`;

const PROTOCOL_MD = `# ApiHub Core v0.1 Protocol (ABI)

## Overview
This document defines the interface between the ApiHub Host and any Guest Plugin.

## Memory Model: Guest-Owned
1. **Allocation**: Host calls Guest's 'malloc'. Guest returns a pointer.
2. **Access**: Host writes directly to Guest memory using the returned pointer.
3. **Responsibility**: Guest tracks allocations (e.g. via map or allocator) to prevent GC from reclaiming active buffers.

## Exports (Guest must implement)
1. 'malloc(size uint32) -> ptr uint32'
2. 'free(ptr uint32)'
3. 'handle(ptr uint32, len uint32) -> packedResult uint64'

## Packed Result
The 'handle' function returns a uint64.
- **High 32 bits**: Pointer to the response buffer.
- **Low 32 bits**: Length of the response buffer.
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
        content: 'module apihub-core\n\ngo 1.22'
      },
      {
        name: 'abi',
        type: 'directory',
        children: [
          { name: 'protocol.md', type: 'file', language: 'markdown', content: PROTOCOL_MD }
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
              { name: 'build.go', type: 'file', language: 'go', content: CLI_BUILD_GO },
              { name: 'init.go', type: 'file', language: 'go', content: '// Implements template generation...' }
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
                  { name: 'invoker.go', type: 'file', language: 'go', content: HOST_INVOKER_GO },
                  { name: 'manager.go', type: 'file', language: 'go', content: HOST_LOADER_GO }
                ]
              },
              { name: 'main.go', type: 'file', language: 'go', content: '// HTTP Server wrapping Runtime...' }
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
              { name: 'main.go', type: 'file', language: 'go', content: EXAMPLE_PLUGIN_GO },
              { name: 'plugin.yaml', type: 'file', language: 'yaml', content: 'name: hello-world\nversion: 0.1.0' }
            ]
          }
        ]
      }
    ]
  }
];
