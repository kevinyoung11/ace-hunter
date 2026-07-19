import Foundation
import Security

let service = "com.kevinyoung.ace-hunter"
let allowed = Set(["migration-database-url", "runtime-database-url", "github-token", "user-id", "deepseek-api-key"])

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
  query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
  var item: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &item)
  if status == errSecItemNotFound { fail("secret_unavailable") }
  guard status == errSecSuccess, let data = item as? Data else { fail("keychain_read_failed") }
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
} else if operation == "delete" {
  let status = SecItemDelete(base as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else { fail("keychain_delete_failed") }
} else {
  fail("operation_not_allowed")
}
