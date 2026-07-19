import Foundation
import Security

let service = "com.kevinyoung.ace-hunter"
let allowed = Set(["runtime-database-url", "github-token", "user-id", "deepseek-api-key"])

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

guard CommandLine.arguments.count == 3 else { fail("usage_error") }
let operation = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
guard allowed.contains(account) else { fail("account_not_allowed") }
let base: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
]

if operation == "get" {
  var query = base
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
        let data = item as? Data else { fail("secret_unavailable") }
  FileHandle.standardOutput.write(data)
} else if operation == "set" {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard !data.isEmpty, data.count <= 16_384 else { fail("invalid_secret") }
  let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
  if status == errSecItemNotFound {
    var insert = base
    insert[kSecValueData as String] = data
    insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { fail("keychain_write_failed") }
  } else if status != errSecSuccess { fail("keychain_write_failed") }
} else {
  fail("operation_not_allowed")
}
