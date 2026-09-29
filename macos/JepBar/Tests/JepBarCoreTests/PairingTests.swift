import Foundation
import XCTest
@testable import JepBarCore

final class PairingTests: XCTestCase {
    func testPicksTheGatewayRow() {
        let json = """
        [{"client":"telegram","label":"Telegram","code":"TG1","owner":"42","devices":1},
         {"client":"gateway","label":"Gateway","code":"ABC123","owner":null,"devices":2,"port":8931}]
        """
        XCTAssertEqual(gatewayPairing(Data(json.utf8)), GatewayPairing(client: "gateway", code: "ABC123", devices: 2, port: 8931))
        XCTAssertNil(gatewayPairing(Data("[]".utf8)))
        XCTAssertNil(gatewayPairing(Data("nope".utf8)))
    }

    func testPairLinkCarriesAddressAndCode() {
        XCTAssertEqual(pairLink(host: "100.101.1.2", port: 8931, code: "ABC123"), "jep://pair?address=100.101.1.2:8931&code=ABC123")
        let c = URLComponents(string: pairLink(host: "10.0.0.5", port: 1, code: "x y&z")!)!
        XCTAssertEqual(c.queryItems?.first { $0.name == "code" }?.value, "x y&z")
    }

    func testTailscaleThenLanAndNoLoopback() {
        XCTAssertEqual(
            rankHosts(["127.0.0.1", "10.0.0.5", "192.168.1.20", "169.254.3.4", "100.101.1.2", "192.168.1.20", "fe80::1"]),
            ["100.101.1.2", "192.168.1.20", "10.0.0.5"]
        )
    }

    func testDataHomeHonoursTheDaemonsVariable() {
        XCTAssertEqual(dataHome(["JEP_DATA_HOME": "/x/y"]).path, "/x/y")
        XCTAssertTrue(dataHome([:]).path.hasSuffix(".local/share/jep-tg"))
    }
}
