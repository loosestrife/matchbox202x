#include <stdio.h>
#include <dlfcn.h>

// Function signature matching jslib_add
typedef int32_t (*jslib_add_fn)(int32_t, int32_t);

int main() {
    // 1. Load the compiled wrapper library
    void *handle = dlopen("./libjslib.so", RTLD_NOW);
    if (!handle) {
        fprintf(stderr, "Error: %s\n", dlerror());
        return 1;
    }

    // 2. Resolve the function pointer via dlsym
    jslib_add_fn add = (jslib_add_fn)dlsym(handle, "jslib_add");
    if (!add) {
        fprintf(stderr, "Symbol not found: %s\n", dlerror());
        return 1;
    }

    // 3. Execute! Crosses C -> QuickJS VM -> JS logic -> C
    int32_t sum = add(15, 27);
    printf("Result from JavaScript via dlsym: %d\n", sum); // Prints: 42

    dlclose(handle);
    return 0;
}