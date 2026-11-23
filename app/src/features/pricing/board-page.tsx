// The comparison pages' own module, loaded only by /compare/* (index.tsx): the board and the stylesheets it needs (its
// own, and the homepage's end band's), so the calculator at /pricing never loads them.
import '../home/machines.css'
import './board.css'
export { BoardEnd, ComparisonBoard } from './board'
