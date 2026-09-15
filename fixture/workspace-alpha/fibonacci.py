import sys


def fibonacci(n: int) -> list[int]:
    if n <= 0:
        return []
    if n == 1:
        return [0]
    if n == 2:
        return [0, 1]

    result = [0, 1]
    for _ in range(2, n):
        result.append(result[-1] + result[-2])
    return result


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python fibonacci.py <number_of_steps>")
        sys.exit(1)

    try:
        steps = int(sys.argv[1])
    except ValueError:
        print("Error: Please provide a valid integer")
        sys.exit(1)

    if steps < 0:
        print("Error: Number of steps must be non-negative")
        sys.exit(1)

    sequence = fibonacci(steps)
    print(" ".join(map(str, sequence)))