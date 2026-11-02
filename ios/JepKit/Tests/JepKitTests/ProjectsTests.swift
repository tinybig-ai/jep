import XCTest
@testable import JepKit

final class ProjectsTests: XCTestCase {
    private func s(_ id: String, _ dir: String, _ updated: Int64, pinned: Bool = false, pod: Bool = false) -> SessionSummary {
        SessionSummary(id: id, title: id, workspace: dir, updatedAt: updated, adapter: dir.split(separator: "/").last.map(String.init), pinned: pinned, pod: pod)
    }

    func testProjectsOrderedByNewestConversation() {
        let list = [s("a", "/x/api", 10), s("b", "/x/web", 30), s("c", "/x/api", 20)]
        let g = groupedProjects(list)
        XCTAssertEqual(g.map(\.dir), ["/x/web", "/x/api"])
        XCTAssertEqual(g[1].sessions.map(\.id), ["a", "c"])
    }

    func testAPinLiftsItsWholeProject() {
        let list = [s("a", "/x/api", 10, pinned: true), s("b", "/x/web", 30)]
        XCTAssertEqual(groupedProjects(list).map(\.dir), ["/x/api", "/x/web"])
    }

    func testPodsShareOneProjectAndAreNamedPods() {
        let list = [s("p1", "/pods/1", 5, pod: true), s("p2", "/pods/2", 6, pod: true)]
        let g = groupedProjects(list)
        XCTAssertEqual(g.count, 1)
        XCTAssertEqual(projectName(g[0].dir, g[0].sessions), "Pods")
    }
}
