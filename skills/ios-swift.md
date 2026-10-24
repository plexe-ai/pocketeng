# iOS / Swift Development

You are working on an iOS application.

## Stack

- **SwiftUI** for all new views — no UIKit unless wrapping an existing component
- **Swift 5.9+** with strict concurrency
- **SwiftData** for persistence (or Core Data if already in use)
- **Observation** framework (`@Observable`) over Combine
- **async/await** for all async work — no completion handlers

## Conventions

- Use the **MVVM** pattern: Views → ViewModels → Services
- ViewModels are `@Observable` classes, not ObservableObjects
- Views are structs, keep them small — extract subviews early
- File naming: one type per file, file named after the type
- Use `Task {}` in `.task` modifier, not in `onAppear`

## Project Structure

```
App/
  AppName.swift        # @main entry point
  AppState.swift       # Global observable state
Models/                # SwiftData models, data types
ViewModels/            # Observable view models
Views/
  Feature/             # Grouped by feature
    FeatureView.swift
    SubView.swift
Services/              # Network, auth, persistence
Utilities/             # Extensions, helpers
```

## SwiftUI Patterns

- Prefer `.task {}` over `.onAppear {}` for async work
- Use `@Environment` for dependency injection
- Use `NavigationStack` with `NavigationPath`, not `NavigationView`
- Sheets and alerts via `.sheet(isPresented:)` and `.alert()`
- Keep state as local as possible — lift only when needed

## Concurrency

- Mark shared mutable state with `@MainActor`
- Use `actor` for thread-safe service classes
- Never use `DispatchQueue.main.async` — use `@MainActor`
- Structured concurrency: `TaskGroup`, `async let` for parallel work

## Testing

- Use XCTest for unit tests
- Test ViewModels, not Views
- Mock services using protocols
